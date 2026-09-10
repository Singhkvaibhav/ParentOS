require("../tests/setupEnv");

// Reconciliation talks to Stripe, so the client is mocked to return
// whatever each test needs the "other system" to believe.
const mockRetrieve = jest.fn();
const mockList = jest.fn().mockResolvedValue({ data: [] });
jest.mock("stripe", () => jest.fn().mockImplementation(() => ({
  paymentIntents: { retrieve: mockRetrieve, list: mockList, create: jest.fn(), cancel: jest.fn() },
  refunds: { create: jest.fn() },
  webhooks: { constructEvent: jest.fn() },
  accounts: { create: jest.fn(), retrieve: jest.fn() },
  accountLinks: { create: jest.fn() },
})));
jest.mock("../ai/controller", () => ({
  AiUnavailableError: class extends Error {},
  getAutoReply: jest.fn().mockResolvedValue("Mocked."),
}));

const app = require("../server");
const { query } = require("../db");
const { resetDb } = require("./dbReset");
const { classify, runReconciliation } = require("../services/reconciliationService");
const { STATUS } = require("../transactionStatus");

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
});

// (#8) The queue must be optional. Requiring Redis to run the app locally
// or in CI would be a cost paid every day for a benefit that only matters
// in production.
describe("job queue degrades gracefully", () => {
  test("is disabled when REDIS_URL isn't set, and enqueue reports that", async () => {
    // The test environment deliberately has no REDIS_URL.
    const queue = require("../queue");
    expect(queue.isEnabled()).toBe(false);

    // Returning false rather than throwing is what lets the caller fall
    // back to running the work inline instead of dropping it.
    const queued = await queue.enqueue(queue.QUEUE_NAMES.AI_REPLY, "generate", {});
    expect(queued).toBe(false);
  });

  test("AI replies still happen with no queue, via the inline fallback", async () => {
    const { createVerifiedUser, makeSellerPayoutReady } = require("./helpers");
    const seller = await createVerifiedUser(app, { email: "queuefallbackseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "queuefallbackbuyer@example.com" });
    const listingRes = await seller.agent.post("/api/listings").send({
      category: "toys", title: "Queue fallback toy", priceCents: 800,
      condition: "Good", city: "Helsinki", area: "Kamppi",
    });
    await makeSellerPayoutReady(listingRes.body.listing.seller_id);

    const send = await buyer.agent.post("/api/messages/thread").send({
      listingId: listingRes.body.listing.id, text: "Still available?",
    });
    expect(send.status).toBe(201);

    // The AI reply is fire-and-forget either way, so wait for it.
    const deadline = Date.now() + 3000;
    let aiMessages = 0;
    while (Date.now() < deadline && aiMessages === 0) {
      const { rows } = await query(
        "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = $1 AND sender_type = 'ai'",
        [send.body.conversation.id]
      );
      aiMessages = Number(rows[0].n);
      if (aiMessages === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(aiMessages).toBe(1);
  });
});

// (#9) classify() is pure, so every discrepancy shape can be tested
// directly without constructing Stripe state for each one.
describe("Stripe reconciliation classification", () => {
  const tx = (status, amount = 5000) => ({ status, total_amount_cents: amount });
  const pi = (status, extra = {}) => ({ status, amount: 5000, ...extra });

  test("agreement produces no issue", () => {
    expect(classify(tx(STATUS.PAID), pi("succeeded"))).toBeNull();
    expect(classify(tx(STATUS.PENDING), pi("requires_confirmation"))).toBeNull();
  });

  // The buyer has been charged and the order never settled - they paid and
  // received nothing.
  test("money taken but order still pending is flagged", () => {
    expect(classify(tx(STATUS.PENDING), pi("succeeded"))).toBe("stripe_succeeded_db_pending");
  });

  // The seller may hand over an item for money that never arrived.
  test("order settled but payment failed is flagged", () => {
    expect(classify(tx(STATUS.PAID), pi("canceled"))).toBe("stripe_failed_db_paid");
    expect(classify(tx(STATUS.FULFILLED), pi("requires_payment_method"))).toBe("stripe_failed_db_paid");
  });

  // A dashboard refund produces no webhook this app listens for, so
  // nothing would otherwise notice.
  test("refunded at Stripe while the order still looks live is flagged", () => {
    expect(classify(tx(STATUS.COMPLETED), pi("succeeded", { amount_refunded: 5000 })))
      .toBe("stripe_refunded_db_active");
  });

  test("an amount mismatch is flagged, but only where money was captured", () => {
    expect(classify(tx(STATUS.PAID, 5000), pi("succeeded", { amount: 4000 }))).toBe("amount_mismatch");
    // Nothing captured yet - a differing amount isn't evidence of a problem.
    expect(classify(tx(STATUS.PENDING, 5000), pi("requires_confirmation", { amount: 4000 }))).toBeNull();
  });
});

describe("reconciliation runs", () => {
  test("records a run even when nothing is wrong, so silence is distinguishable from not running", async () => {
    mockRetrieve.mockReset();
    const result = await runReconciliation();
    expect(result).toHaveProperty("runId");
    expect(result.issuesFound).toBe(0);

    const { rows } = await query("SELECT * FROM reconciliation_runs WHERE id = $1", [result.runId]);
    expect(rows[0].finished_at).not.toBeNull();
  });

  test("a discrepancy is recorded once, not re-reported on every pass", async () => {
    const { createVerifiedUser, makeSellerPayoutReady } = require("./helpers");
    const seller = await createVerifiedUser(app, { email: "reconseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "reconbuyer@example.com" });
    const listingRes = await seller.agent.post("/api/listings").send({
      category: "toys", title: "Recon toy", priceCents: 5000,
      condition: "Good", city: "Helsinki", area: "Kamppi",
    });
    await makeSellerPayoutReady(listingRes.body.listing.seller_id);

    // A pending transaction whose payment actually succeeded at Stripe.
    await query(
      `INSERT INTO transactions (listing_id, buyer_id, seller_id, status, delivery_method,
         item_amount_cents, commission_amount_cents, total_amount_cents, stripe_payment_intent_id)
       VALUES ($1, $2, $3, 'pending', 'pickup', 5000, 400, 5000, 'pi_recon_test')`,
      [listingRes.body.listing.id, buyer.user.id, seller.user.id]
    );
    mockRetrieve.mockResolvedValue({ id: "pi_recon_test", status: "succeeded", amount: 5000 });

    const first = await runReconciliation();
    expect(first.issuesFound).toBe(1);

    // Running again must not duplicate it - re-reporting every pass would
    // bury genuinely new problems.
    const second = await runReconciliation();
    expect(second.issuesFound).toBe(0);

    const { rows } = await query(
      "SELECT COUNT(*) AS n FROM reconciliation_issues WHERE stripe_payment_intent_id = 'pi_recon_test' AND status = 'open'"
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  test("a PaymentIntent Stripe doesn't recognise is itself flagged", async () => {
    const { rows: before } = await query("SELECT COUNT(*) AS n FROM reconciliation_issues WHERE issue_type = 'stripe_missing'");

    await query("UPDATE transactions SET stripe_payment_intent_id = 'pi_ghost' WHERE stripe_payment_intent_id = 'pi_recon_test'");
    await query("UPDATE reconciliation_issues SET status = 'ignored' WHERE status = 'open'");
    mockRetrieve.mockRejectedValue(Object.assign(new Error("No such payment_intent"), { code: "resource_missing" }));

    await runReconciliation();
    const { rows: after } = await query("SELECT COUNT(*) AS n FROM reconciliation_issues WHERE issue_type = 'stripe_missing'");
    expect(Number(after[0].n)).toBeGreaterThan(Number(before[0].n));
  });
});

describe("reconciliation API is admin-only", () => {
  test("a non-admin can't list issues or trigger a run", async () => {
    const { createVerifiedUser } = require("./helpers");
    const user = await createVerifiedUser(app, { email: "reconnotadmin@example.com" });
    expect((await user.agent.get("/api/reconciliation/issues")).status).toBe(403);
    expect((await user.agent.post("/api/reconciliation/run")).status).toBe(403);
  });

  test("an admin sees issues alongside the last run", async () => {
    const { createVerifiedUser } = require("./helpers");
    const admin = await createVerifiedUser(app, { email: "reconadmin@example.com" });
    await query("UPDATE users SET is_admin = true WHERE id = $1", [admin.user.id]);

    const res = await admin.agent.get("/api/reconciliation/issues");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("issues");
    // Without this, an empty issue list is ambiguous: "nothing wrong" and
    // "hasn't run in a week" look identical.
    expect(res.body).toHaveProperty("lastRun");
  });
});

// Production readiness surfaces. These exist for machines - a load
// balancer, an orchestrator, a metrics scraper - so a change that quietly
// alters their contract wouldn't be noticed by any human-facing test.
describe("operational endpoints", () => {
  const request = require("supertest");

  test("liveness never touches the database", async () => {
    // Deliberately checks the CONTRACT, not just the status code. A
    // liveness probe that checks dependencies is an outage amplifier: a
    // database blip makes every instance report unhealthy, the
    // orchestrator kills them all, and a recoverable problem becomes a
    // total outage.
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body).not.toHaveProperty("db");
  });

  test("readiness reports dependency state", async () => {
    const res = await request(app).get("/api/ready");
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(res.body.checks.database).toBe("ok");
    // Redis is optional by design, so its absence must not make an
    // instance unready - only report it.
    expect(res.body.checks).toHaveProperty("queue");
  });

  test("metrics are Prometheus text format with pool saturation exposed", async () => {
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    // The gauge that warns before users feel slowness.
    expect(res.text).toContain("parentos_db_pool_waiting");
    expect(res.text).toContain("# TYPE parentos_uptime_seconds gauge");
  });
});

describe("startup configuration validation", () => {
  // The shared test env (tests/setupEnv.js) already sets several of these,
  // so a test asserting something is MISSING has to be able to unset it -
  // passing null does that. Without it, the "missing webhook secret" case
  // silently tested nothing.
  const withEnv = (env, fn) => {
    const saved = { ...process.env };
    for (const [k, v] of Object.entries(env)) {
      if (v === null) delete process.env[k];
      else process.env[k] = v;
    }
    try { return fn(); } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  };

  test("a development-default secret is rejected in production", () => {
    const { errors } = withEnv(
      { NODE_ENV: "production", JWT_SECRET: "dev-secret", DATABASE_URL: "postgres://real", CORS_ORIGINS: null },
      () => { jest.resetModules(); return require("../configCheck").check(); }
    );
    expect(errors.join(" ")).toMatch(/well-known development value/);
  });

  test("a wildcard CORS origin is rejected, since cookies are credentialed", () => {
    const { errors } = withEnv(
      { NODE_ENV: "production", JWT_SECRET: "x".repeat(40), DATABASE_URL: "postgres://real", CORS_ORIGINS: "*" },
      () => { jest.resetModules(); return require("../configCheck").check(); }
    );
    expect(errors.join(" ")).toMatch(/wildcard/);
  });

  test("missing webhook secret is an error, not a warning", () => {
    // Without it, signatures can't be verified: either payments never
    // settle, or forged webhooks are accepted.
    const { errors } = withEnv(
      { NODE_ENV: "production", JWT_SECRET: "x".repeat(40), DATABASE_URL: "postgres://real",
        CORS_ORIGINS: "https://a.example", STRIPE_SECRET_KEY: "sk_live_x",
        STRIPE_WEBHOOK_SECRET: null, SMTP_HOST: "smtp.example" },
      () => { jest.resetModules(); return require("../configCheck").check(); }
    );
    expect(errors.join(" ")).toMatch(/STRIPE_WEBHOOK_SECRET/);
  });

  // Object storage is REQUIRED in production, not advisory. Local disk on a
  // container filesystem means every deploy silently deletes every uploaded
  // photo, and a second instance can't see the first one's files - a failure
  // that only becomes visible once the damage is done.
  test("missing object storage refuses to start", () => {
    const { errors } = withEnv(
      { NODE_ENV: "production", JWT_SECRET: "x".repeat(40), DATABASE_URL: "postgres://real",
        CORS_ORIGINS: "https://a.example", STRIPE_SECRET_KEY: "sk_live_x",
        STRIPE_WEBHOOK_SECRET: "whsec_x", SMTP_HOST: "smtp.example",
        FRONTEND_URL: "https://a.example", S3_BUCKET: null },
      () => { jest.resetModules(); return require("../configCheck").check(); }
    );
    expect(errors.join(" ")).toMatch(/S3_BUCKET/);
  });

  test("a bucket without credentials is refused too", () => {
    const { errors } = withEnv(
      { NODE_ENV: "production", JWT_SECRET: "x".repeat(40), DATABASE_URL: "postgres://real",
        CORS_ORIGINS: "https://a.example", STRIPE_SECRET_KEY: "sk_live_x",
        STRIPE_WEBHOOK_SECRET: "whsec_x", SMTP_HOST: "smtp.example",
        FRONTEND_URL: "https://a.example",
        S3_BUCKET: "uploads", S3_REGION: "eu-north-1", S3_ACCESS_KEY_ID: null },
      () => { jest.resetModules(); return require("../configCheck").check(); }
    );
    expect(errors.join(" ")).toMatch(/S3_ACCESS_KEY_ID/);
  });

  // Redis is genuinely optional - the app falls back to running jobs
  // in-process - so it warns rather than refusing.
  test("a fully configured production environment starts, warning only about Redis", () => {
    const { errors, warnings } = withEnv(
      { NODE_ENV: "production", JWT_SECRET: "x".repeat(40), DATABASE_URL: "postgres://real",
        CORS_ORIGINS: "https://a.example", STRIPE_SECRET_KEY: "sk_live_x",
        STRIPE_WEBHOOK_SECRET: "whsec_x", SMTP_HOST: "smtp.example",
        FRONTEND_URL: "https://a.example",
        S3_BUCKET: "uploads", S3_REGION: "eu-north-1",
        S3_ACCESS_KEY_ID: "AKIA_x", S3_SECRET_ACCESS_KEY: "secret_x",
        REDIS_URL: null },
      () => { jest.resetModules(); return require("../configCheck").check(); }
    );
    expect(errors).toHaveLength(0);
    expect(warnings.join(" ")).toMatch(/REDIS_URL/);
  });

  // The bug this whole area exists to prevent: the server read
  // ALLOWED_ORIGINS while the check validated CORS_ORIGINS, so production
  // could pass validation and then silently serve the localhost default.
  test("the check validates the same origins the server will actually use", () => {
    const { errors } = withEnv(
      { NODE_ENV: "production", JWT_SECRET: "x".repeat(40), DATABASE_URL: "postgres://real",
        CORS_ORIGINS: null, ALLOWED_ORIGINS: null,
        STRIPE_SECRET_KEY: "sk_live_x", STRIPE_WEBHOOK_SECRET: "whsec_x",
        SMTP_HOST: "smtp.example", FRONTEND_URL: "https://a.example",
        S3_BUCKET: "uploads", S3_REGION: "eu-north-1",
        S3_ACCESS_KEY_ID: "AKIA_x", S3_SECRET_ACCESS_KEY: "secret_x" },
      () => { jest.resetModules(); return require("../configCheck").check(); }
    );
    // Neither variable set: must be refused rather than falling back to
    // http://localhost:5173 and blocking the real frontend.
    expect(errors.join(" ")).toMatch(/CORS_ORIGINS/);
  });

  test("the legacy ALLOWED_ORIGINS still works, but is flagged as deprecated", () => {
    const { errors, warnings } = withEnv(
      { NODE_ENV: "production", JWT_SECRET: "x".repeat(40), DATABASE_URL: "postgres://real",
        CORS_ORIGINS: null, ALLOWED_ORIGINS: "https://a.example",
        STRIPE_SECRET_KEY: "sk_live_x", STRIPE_WEBHOOK_SECRET: "whsec_x",
        SMTP_HOST: "smtp.example", FRONTEND_URL: "https://a.example",
        S3_BUCKET: "uploads", S3_REGION: "eu-north-1",
        S3_ACCESS_KEY_ID: "AKIA_x", S3_SECRET_ACCESS_KEY: "secret_x" },
      () => { jest.resetModules(); return require("../configCheck").check(); }
    );
    expect(errors).toHaveLength(0);
    expect(warnings.join(" ")).toMatch(/ALLOWED_ORIGINS/);
  });

  test("a plain-http FRONTEND_URL is refused - reset links would be unencrypted", () => {
    const { errors } = withEnv(
      { NODE_ENV: "production", JWT_SECRET: "x".repeat(40), DATABASE_URL: "postgres://real",
        CORS_ORIGINS: "https://a.example", STRIPE_SECRET_KEY: "sk_live_x",
        STRIPE_WEBHOOK_SECRET: "whsec_x", SMTP_HOST: "smtp.example",
        FRONTEND_URL: "http://a.example",
        S3_BUCKET: "uploads", S3_REGION: "eu-north-1",
        S3_ACCESS_KEY_ID: "AKIA_x", S3_SECRET_ACCESS_KEY: "secret_x" },
      () => { jest.resetModules(); return require("../configCheck").check(); }
    );
    expect(errors.join(" ")).toMatch(/FRONTEND_URL/);
  });

  test("development is not held to production requirements", () => {
    const { ok } = withEnv(
      { NODE_ENV: "development", JWT_SECRET: "dev-secret", DATABASE_URL: "postgres://localhost/x" },
      () => { jest.resetModules(); return require("../configCheck").check(); }
    );
    expect(ok).toBe(true);
  });
});

// Behind a reverse proxy, req.ip is the proxy's address unless Express is
// told how many hops to trust. That silently breaks per-IP rate limiting
// (one shared bucket for everyone), login history, suspicious-login
// detection and password-reset attribution.
describe("proxy trust", () => {
  const express = require("express");

  function ipBehind(hops, forwardedFor) {
    return new Promise((resolve) => {
      const app = express();
      if (hops !== null) app.set("trust proxy", hops);
      app.get("/", (req, res) => res.json({ ip: req.ip }));
      const server = app.listen(0, async () => {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/`, {
          headers: { "X-Forwarded-For": forwardedFor },
        });
        const { ip } = await res.json();
        server.close(() => resolve(ip));
      });
    });
  }

  test("without trust proxy the client IP is lost", async () => {
    expect(await ipBehind(null, "203.0.113.7")).toBe("127.0.0.1");
  });

  test("trusting one hop recovers the real client IP", async () => {
    expect(await ipBehind(1, "203.0.113.7")).toBe("203.0.113.7");
  });

  // The reason the setting is a hop COUNT and not `true`.
  test("a hop count resists a forged X-Forwarded-For chain", async () => {
    // An attacker prepends addresses hoping to be seen as one of them.
    // With one trusted hop, only the address nginx itself appended counts.
    expect(await ipBehind(1, "1.1.1.1, 2.2.2.2, 203.0.113.7")).toBe("203.0.113.7");
    // `true` trusts the whole chain, so the attacker picks their own IP -
    // and walks through every per-IP limit.
    expect(await ipBehind(true, "1.1.1.1, 2.2.2.2, 203.0.113.7")).toBe("1.1.1.1");
  });

  test("the server enables it in production and not in development", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
    expect(src).toMatch(/trust proxy/);
    // Guarded, because trusting a header nobody sets in development would
    // be the same spoofing hole with no upside.
    expect(src).toMatch(/NODE_ENV === "production"[\s\S]{0,200}trust proxy/);
  });
});

// The build accepted VITE_API_BASE while the app read VITE_API_URL, so a
// custom API URL passed at build time was silently ignored.
describe("frontend build configuration", () => {
  test("the Dockerfile sets the variable the app actually reads", () => {
    const fs = require("fs");
    const path = require("path");
    const root = path.join(__dirname, "..", "..");
    const dockerfile = fs.readFileSync(path.join(root, "frontend", "Dockerfile"), "utf8");
    const apiClient = fs.readFileSync(path.join(root, "frontend", "src", "services", "api.js"), "utf8");

    const readByApp = /import\.meta\.env\.(VITE_[A-Z_]+)/.exec(apiClient)[1];
    expect(dockerfile).toMatch(new RegExp(`ARG ${readByApp}`));
    expect(dockerfile).toMatch(new RegExp(`ENV ${readByApp}=`));
  });
});


// The forward pass walks transactions and asks Stripe about each, so it can
// only find problems with rows that EXIST. A PaymentIntent created during
// checkout whose transaction row was never written has nothing to walk
// from - which is exactly what the reservation window can produce.
describe("reverse reconciliation: Stripe -> database", () => {
  const { findOrphanedPaymentIntents } = require("../services/reconciliationService");

  beforeEach(() => { mockList.mockReset(); });

  test("a PaymentIntent with no local transaction is flagged", async () => {
    mockList.mockResolvedValue({
      data: [{ id: "pi_orphan_1", status: "succeeded", amount: 4200 }],
    });

    const result = await findOrphanedPaymentIntents();
    expect(result.orphans).toBe(1);

    const { rows } = await query(
      "SELECT issue_type, stripe_amount_cents FROM reconciliation_issues WHERE stripe_payment_intent_id = $1",
      ["pi_orphan_1"]
    );
    expect(rows[0].issue_type).toBe("orphaned_payment_intent");
    expect(rows[0].stripe_amount_cents).toBe(4200);
  });

  test("a PaymentIntent that DOES have a local row is not flagged", async () => {
    const { createVerifiedUser } = require("./helpers");
    const u = await createVerifiedUser(app, { email: `notorphan${Date.now()}@example.com` });
    const listing = await query(
      `INSERT INTO listings (seller_id,category,title,price_cents,condition,city,area,pincode,status)
       VALUES ($1,'toys','x',100,'Good','Helsinki','Kamppi','00100','sold') RETURNING id`,
      [u.user.id]
    );
    await query(
      `INSERT INTO transactions (listing_id,buyer_id,seller_id,item_amount_cents,delivery_method,
         delivery_fee_cents,commission_amount_cents,total_amount_cents,status,stripe_payment_intent_id)
       VALUES ($1,$2,$2,100,'pickup',0,8,100,'paid','pi_known_1')`,
      [listing.rows[0].id, u.user.id]
    );

    mockList.mockResolvedValue({ data: [{ id: "pi_known_1", status: "succeeded", amount: 100 }] });
    const result = await findOrphanedPaymentIntents();
    expect(result.orphans).toBe(0);
  });

  // An abandoned checkout is not an orphan: no money is at stake, and
  // flagging them would bury the cases that matter.
  test("an unpaid or cancelled PaymentIntent is ignored", async () => {
    mockList.mockResolvedValue({
      data: [
        { id: "pi_abandoned", status: "requires_payment_method", amount: 500 },
        { id: "pi_cancelled", status: "canceled", amount: 500 },
      ],
    });
    const result = await findOrphanedPaymentIntents();
    expect(result.orphans).toBe(0);
  });

  // transaction_id is NULL for an orphan, and NULL <> NULL in SQL - so the
  // original unique index would have let every pass insert another copy.
  test("the same orphan is not re-reported on every pass", async () => {
    mockList.mockResolvedValue({ data: [{ id: "pi_orphan_dup", status: "succeeded", amount: 900 }] });

    const first = await findOrphanedPaymentIntents();
    const second = await findOrphanedPaymentIntents();
    expect(first.orphans).toBe(1);
    expect(second.orphans).toBe(0);

    const { rows } = await query(
      "SELECT COUNT(*) AS n FROM reconciliation_issues WHERE stripe_payment_intent_id = $1",
      ["pi_orphan_dup"]
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  test("it degrades quietly when Stripe isn't configured", async () => {
    const original = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    jest.resetModules();
    try {
      const svc = require("../services/reconciliationService");
      const result = await svc.findOrphanedPaymentIntents();
      // Reports that it skipped rather than throwing - reconciliation
      // running with one blind half is better than not running.
      expect(result.checked).toBe(0);
    } finally {
      process.env.STRIPE_SECRET_KEY = original;
      jest.resetModules();
    }
  });
});
