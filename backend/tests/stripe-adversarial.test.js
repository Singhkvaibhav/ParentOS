require("../tests/setupEnv");

jest.mock("../ai/controller", () => ({
  AiUnavailableError: class extends Error {},
  getAutoReply: jest.fn().mockResolvedValue("Mocked."),
}));

const mockCreate = jest.fn();
const mockCancel = jest.fn().mockResolvedValue({ id: "pi_cancelled" });
const mockRefund = jest.fn().mockResolvedValue({ id: "re_1" });
jest.mock("stripe", () => jest.fn().mockImplementation(() => ({
  paymentIntents: { create: mockCreate, cancel: mockCancel, retrieve: jest.fn() },
  refunds: { create: mockRefund },
  webhooks: { constructEvent: jest.fn().mockImplementation((raw) => JSON.parse(raw.toString())) },
  accounts: { create: jest.fn(), retrieve: jest.fn() },
  accountLinks: { create: jest.fn() },
})));

const request = require("supertest");
const app = require("../server");
const { query } = require("../db");
const { resetDb } = require("./dbReset");
const { createVerifiedUser, createListing: createListingBase } = require("./helpers");

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
});

beforeEach(() => {
  mockCreate.mockReset();
  mockCancel.mockClear();
  mockRefund.mockClear();
  mockCreate.mockImplementation(async ({ amount, metadata }) => ({
    id: `pi_adv_${Math.random().toString(36).slice(2)}`,
    client_secret: "cs", amount, metadata,
  }));
});

async function seller(email) {
  const s = await createVerifiedUser(app, { email });
  return s;
}

async function listingFor(agent, overrides = {}) {
  return createListingBase(agent, { category: "toys", title: "Adversarial toy", priceCents: 3000, ...overrides });
}

function webhook(type, object) {
  return request(app).post("/api/v1/transactions/webhook")
    .set("Content-Type", "application/json").set("stripe-signature", "sig")
    .send(JSON.stringify({ type, data: { object } }));
}

// Scenario A: the PaymentIntent exists at Stripe but persisting our record
// fails. Money is committed at the provider with nothing here remembering
// it - the orphaned-payment case.
describe("A: PaymentIntent created, then the database write fails", () => {
  test("the PaymentIntent is cancelled and the listing released, not left reserved", async () => {
    const s = await seller("advAseller@example.com");
    const b = await createVerifiedUser(app, { name: "B", email: "advAbuyer@example.com" });
    const listing = await listingFor(s.agent);

    // Force a GENUINE database failure rather than mocking an internal:
    // transactionsService destructures withTransaction at require time, so
    // reassigning it on the module has no effect - and a test that mocks
    // the thing it's meant to be exercising proves little anyway.
    //
    // Instead, make Stripe hand back a PaymentIntent id that already
    // exists. The unique index on stripe_payment_intent_id then rejects
    // the insert, which is exactly the "Stripe succeeded, our write did
    // not" shape this scenario is about.
    const collidingId = `pi_collide_${Date.now()}`;
    const other = await listingFor(s.agent, { title: "Collision holder" });
    await query(
      `INSERT INTO transactions (listing_id, buyer_id, seller_id, item_amount_cents,
         delivery_method, delivery_fee_cents, commission_amount_cents, total_amount_cents,
         status, stripe_payment_intent_id)
       VALUES ($1, $2, $3, 100, 'pickup', 0, 8, 100, 'pending', $4)`,
      [other.id, b.user.id, s.user.id, collidingId]
    );
    mockCreate.mockResolvedValueOnce({ id: collidingId, client_secret: "cs", amount: 3000 });

    const res = await b.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });

    expect(res.status).toBeGreaterThanOrEqual(400);
    // Cancelled at Stripe, so no money can ever be captured for a sale we
    // have no record of.
    expect(mockCancel).toHaveBeenCalled();

    // And the listing is buyable again rather than stuck reserved forever.
    const { rows } = await query("SELECT status, reserved_at FROM listings WHERE id = $1", [listing.id]);
    expect(rows[0].status).toBe("active");
    expect(rows[0].reserved_at).toBeNull();
  });
});

// Scenario B: the reservation sweep runs before a slow webhook arrives.
// The listing is released, then payment settles - the buyer has paid for
// something that has been put back on sale.
describe("B: webhook arrives after the reservation has expired", () => {
  test("a late success still settles the order rather than losing the payment", async () => {
    const s = await seller("advBseller@example.com");
    const b = await createVerifiedUser(app, { name: "B", email: "advBbuyer@example.com" });
    const listing = await listingFor(s.agent);

    const checkout = await b.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });
    const pi = checkout.body.transaction.stripe_payment_intent_id;

    // Age the reservation past its TTL and sweep, as the scheduler would.
    await query("UPDATE listings SET reserved_at = now() - interval '2 hours' WHERE id = $1", [listing.id]);
    const { releaseExpiredReservations } = require("../services/transactionsService");
    await releaseExpiredReservations();

    // Now the delayed webhook lands.
    const res = await webhook("payment_intent.succeeded", { id: pi });
    expect(res.status).toBe(200);

    const { rows } = await query("SELECT status FROM transactions WHERE stripe_payment_intent_id = $1", [pi]);
    // Whatever the outcome, the money must not be silently kept against an
    // order left 'pending' - it either settles or is refunded.
    expect(["paid", "refunded"]).toContain(rows[0].status);

    // If it settled, the listing must not still be on sale.
    if (rows[0].status === "paid") {
      const l = await query("SELECT status FROM listings WHERE id = $1", [listing.id]);
      expect(l.rows[0].status).toBe("sold");
    }
  });
});

// Scenario C: the refund succeeds at Stripe but the database transition
// that records it fails. Money has left the account with nothing here
// saying so - and because Stripe delivers at-least-once, the same event
// arrives again and the refund path runs a second time.
describe("C: Stripe refund succeeds, then the database transition fails", () => {
  test("a retried late-payment refund reuses one idempotency key, so the buyer isn't refunded twice", async () => {
    const s = await seller("advCseller@example.com");
    const b = await createVerifiedUser(app, { name: "B", email: "advCbuyer@example.com" });
    const listing = await listingFor(s.agent);

    const checkout = await b.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });
    const pi = checkout.body.transaction.stripe_payment_intent_id;
    const transactionId = checkout.body.transaction.id;

    // Put the order in a state where a further success is a LATE payment:
    // already resolved, so the money has to go back.
    await query("UPDATE transactions SET status = 'cancelled' WHERE id = $1", [transactionId]);
    await query("UPDATE listings SET status = 'active', reserved_at = NULL WHERE id = $1", [listing.id]);

    // First delivery: refund fires, then the transition fails. The catch
    // swallows it, exactly as it would if the database blipped.
    const orderStateMachine = require("../services/orderStateMachine");
    const realTransition = orderStateMachine.transitionOrder;
    orderStateMachine.transitionOrder = jest.fn().mockRejectedValue(new Error("database went away"));

    await webhook("payment_intent.succeeded", { id: pi });
    orderStateMachine.transitionOrder = realTransition;

    // Stripe retries the same event.
    await webhook("payment_intent.succeeded", { id: pi });

    const refundCalls = mockRefund.mock.calls;
    expect(refundCalls.length).toBeGreaterThanOrEqual(1);

    // However many times the path ran, every call carried the SAME
    // idempotency key - so Stripe returns the original refund rather than
    // creating a second one. Without a key each retry would be a fresh
    // refund and the buyer would get their money back twice.
    const keys = new Set(refundCalls.map(([, opts]) => opts?.idempotencyKey));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe(`late-payment-refund-${transactionId}`);
  });

  test("every refund in the codebase passes an idempotency key", async () => {
    // A refund without one is a double-refund waiting for a retry, and
    // retries are normal rather than exceptional. Asserted structurally so
    // a new refund call site can't quietly omit it.
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "..", "services");

    const offenders = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
      const src = fs.readFileSync(path.join(dir, file), "utf8");
      const re = /refunds\.create\(/g;
      let m;
      while ((m = re.exec(src))) {
        // A key can be passed inline or via a variable (the saga builds an
        // `options` object above the call), so look at a window around the
        // call rather than only inside its parentheses - matching only the
        // literal at the call site produced a false positive on code that
        // was in fact correct.
        const window = src.slice(Math.max(0, m.index - 800), m.index + 400);
        if (!window.includes("idempotencyKey")) {
          offenders.push(`${file}: ${src.slice(m.index, m.index + 70).replace(/\s+/g, " ")}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the moderation saga reuses its stored key when a task is retried", async () => {
    const admin = await createVerifiedUser(app, { name: "A", email: "advCadmin@example.com" });
    await query("UPDATE users SET is_admin = true WHERE id = $1", [admin.user.id]);
    const s = await seller("advCmodseller@example.com");
    const b = await createVerifiedUser(app, { name: "B", email: "advCmodbuyer@example.com" });
    const listing = await listingFor(s.agent);

    const checkout = await b.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });
    await webhook("payment_intent.succeeded", { id: checkout.body.transaction.stripe_payment_intent_id });

    // Make the refund fail so the task is retried rather than settled.
    mockRefund.mockRejectedValueOnce(new Error("Stripe unavailable"));
    await admin.agent.post(`/api/v1/moderation/listings/${listing.id}/takedown`).send({ reason: "Recalled" });

    const { rows: before } = await query(
      "SELECT idempotency_key, attempts, state FROM moderation_refund_tasks WHERE transaction_id = $1",
      [checkout.body.transaction.id]
    );
    expect(before[0].state).toBe("pending");
    const storedKey = before[0].idempotency_key;

    mockRefund.mockClear();
    const { drainTasks } = require("../services/moderationSagaService");
    await drainTasks({});

    // The retry sends the key persisted at takedown time, not a new one -
    // which is what makes retrying a refund safe at all.
    const used = mockRefund.mock.calls.map(([, opts]) => opts?.idempotencyKey);
    expect(used).toContain(storedKey);
  });

  test("a task abandoned mid-processing (crashed worker) is reclaimed, not stuck forever", async () => {
    const admin = await createVerifiedUser(app, { name: "A", email: "advCadmin2@example.com" });
    await query("UPDATE users SET is_admin = true WHERE id = $1", [admin.user.id]);
    const s = await seller("advCmodseller2@example.com");
    const b = await createVerifiedUser(app, { name: "B", email: "advCmodbuyer2@example.com" });
    const listing = await listingFor(s.agent);

    const checkout = await b.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });
    await webhook("payment_intent.succeeded", { id: checkout.body.transaction.stripe_payment_intent_id });
    await admin.agent.post(`/api/v1/moderation/listings/${listing.id}/takedown`).send({ reason: "Recalled" });

    // Simulate a worker that claimed the task and then crashed before
    // recording success or failure - the exact state the durable-claim
    // migration's `started_at` column exists to detect. Backdated well
    // past the staleness window so this run's own claim attempt (which
    // also sets started_at = now()) can't coincidentally look fresh.
    await query(
      `UPDATE moderation_refund_tasks
       SET state = 'processing', started_at = now() - interval '1 hour'
       WHERE transaction_id = $1`,
      [checkout.body.transaction.id]
    );

    const { drainTasks } = require("../services/moderationSagaService");
    const result = await drainTasks({});

    // Reclaimed and completed, not skipped as "already processing".
    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(1);

    const { rows: after } = await query(
      "SELECT state FROM moderation_refund_tasks WHERE transaction_id = $1",
      [checkout.body.transaction.id]
    );
    expect(after[0].state).toBe("succeeded");
  });
});

// Scenario D: Stripe retries deliver the same event several times at once.
// At-least-once delivery is normal; double-settling is not.
describe("D: the same webhook delivered concurrently", () => {
  test("five simultaneous deliveries settle the order exactly once", async () => {
    const s = await seller("advDseller@example.com");
    const b = await createVerifiedUser(app, { name: "B", email: "advDbuyer@example.com" });
    const listing = await listingFor(s.agent);

    const checkout = await b.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });
    const pi = checkout.body.transaction.stripe_payment_intent_id;

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => webhook("payment_intent.succeeded", { id: pi }))
    );
    for (const r of responses) expect(r.status).toBe(200);

    const { rows } = await query("SELECT status FROM transactions WHERE stripe_payment_intent_id = $1", [pi]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("paid");

    // Exactly one settlement recorded in the audit trail - duplicates here
    // would mean the trust counters and analytics were double-counting.
    const events = await query(
      `SELECT COUNT(*) AS n FROM transaction_events e
       JOIN transactions t ON t.id = e.transaction_id
       WHERE t.stripe_payment_intent_id = $1 AND e.to_status = 'paid'`,
      [pi]
    );
    expect(Number(events.rows[0].n)).toBe(1);

    // And no refund was triggered by treating a retry as a late payment.
    expect(mockRefund).not.toHaveBeenCalled();
  });
});

// Scenario E: events arrive out of order. Stripe does not guarantee
// ordering, so a failure after a success must not undo the success.
describe("E: payment_failed and payment_succeeded arrive out of order", () => {
  test("a failure arriving after a success does not unsettle a paid order", async () => {
    const s = await seller("advEseller@example.com");
    const b = await createVerifiedUser(app, { name: "B", email: "advEbuyer@example.com" });
    const listing = await listingFor(s.agent);

    const checkout = await b.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });
    const pi = checkout.body.transaction.stripe_payment_intent_id;

    await webhook("payment_intent.succeeded", { id: pi });
    await webhook("payment_intent.payment_failed", { id: pi });

    const { rows } = await query("SELECT status FROM transactions WHERE stripe_payment_intent_id = $1", [pi]);
    // Money was captured; a stale failure event must not reverse that.
    expect(rows[0].status).toBe("paid");

    const l = await query("SELECT status FROM listings WHERE id = $1", [listing.id]);
    expect(l.rows[0].status).toBe("sold");
  });

  test("a failure with no prior success releases the listing", async () => {
    const s = await seller("advEseller2@example.com");
    const b = await createVerifiedUser(app, { name: "B", email: "advEbuyer2@example.com" });
    const listing = await listingFor(s.agent);

    const checkout = await b.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });
    await webhook("payment_intent.payment_failed", { id: checkout.body.transaction.stripe_payment_intent_id });

    const l = await query("SELECT status FROM listings WHERE id = $1", [listing.id]);
    expect(l.rows[0].status).toBe("active");
  });
});

// Scenario F: the seller's Connect account is disabled between checkout and
// payout. Money is already captured for someone who can no longer receive it.
describe("F: seller's Connect account is disabled after checkout", () => {
  test("checkout is blocked for a seller who cannot be paid", async () => {
    const s = await seller("advFseller@example.com");
    const b = await createVerifiedUser(app, { name: "B", email: "advFbuyer@example.com" });
    const listing = await listingFor(s.agent);

    // Disable payouts, as Stripe would after a failed verification.
    await query("UPDATE users SET connect_charges_enabled = false WHERE id = $1", [s.user.id]);

    const res = await b.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });
    // Money must never be collected on behalf of someone who cannot
    // receive it.
    expect(res.status).toBe(409);
  });

  test("an order already paid before disablement is still visible and refundable", async () => {
    const s = await seller("advFseller2@example.com");
    const b = await createVerifiedUser(app, { name: "B", email: "advFbuyer2@example.com" });
    const listing = await listingFor(s.agent);

    const checkout = await b.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });
    await webhook("payment_intent.succeeded", { id: checkout.body.transaction.stripe_payment_intent_id });

    await query("UPDATE users SET connect_charges_enabled = false WHERE id = $1", [s.user.id]);

    // The buyer isn't stranded: the order still exists and the dispute
    // route remains open, so captured money has a way back.
    const mine = await b.agent.get("/api/v1/transactions/mine");
    expect(mine.body.transactions.some((t) => t.id === checkout.body.transaction.id)).toBe(true);

    const dispute = await b.agent.post(`/api/v1/transactions/${checkout.body.transaction.id}/dispute`)
      .send({ reason: "Seller can no longer be paid out" });
    expect(dispute.status).toBe(200);
  });
});
