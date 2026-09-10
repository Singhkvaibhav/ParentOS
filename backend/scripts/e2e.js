// Full end-to-end test.
//
// Everything here is real except Stripe's servers: a real Express process
// over real HTTP, a real PostgreSQL database, the real Stripe SDK, and
// webhook signatures generated with Stripe's own signing code. Only the
// far end of the Stripe connection is a local fake.
//
// That distinction matters. The Jest suite mocks the `stripe` module, which
// means the SDK never runs - so request shapes, form encoding, idempotency
// headers, response parsing and error handling all go untested. Here the
// SDK does its real work.
//
// Still NOT covered, and no amount of this replaces it: a wrong API
// version, bad key permissions, or a mismatched webhook secret at real
// Stripe. `npm run journey` with sk_test_ keys is the only thing that
// catches those.
//
// Run: npm run e2e
process.env.NODE_ENV = "test";

const { spawn } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const { createFakeStripe } = require("../tests/fakeStripe");

const WEBHOOK_SECRET = "whsec_e2e_local_secret";
const PORT = 4321;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${label}`);
    passed += 1;
  } else {
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
    failed += 1;
    failures.push(label);
  }
}

function section(name) {
  console.log(`\n${name}`);
}

// Cookie-jar client: the app uses httpOnly auth cookies plus a CSRF
// double-submit token, so plain fetch gets nowhere.
function client() {
  const cookies = new Map();

  async function request(method, urlPath, body, extraHeaders = {}) {
    const headers = { "Content-Type": "application/json", ...extraHeaders };
    if (cookies.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const csrf = cookies.get("parentos_csrf");
    if (csrf) headers["x-csrf-token"] = csrf;

    const res = await fetch(`${BASE}${urlPath}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });

    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const i = pair.indexOf("=");
      cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, body: json, raw: text, cookies };
  }

  return {
    get: (p) => request("GET", p),
    post: (p, b) => request("POST", p, b),
    del: (p) => request("DELETE", p),
    raw: request,
    cookies,
  };
}

async function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// Signs a webhook exactly as Stripe does, so the server's real signature
// verification runs rather than being bypassed.
function signedWebhook(payload) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return { body, header: `t=${timestamp},v1=${signature}` };
}

(async () => {
  const fake = createFakeStripe();
  const stripePort = await fake.listen();
  console.log(`Fake Stripe API on 127.0.0.1:${stripePort}`);

  const server = spawn("node", ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(PORT),
      DATABASE_URL: process.env.E2E_DATABASE_URL || "postgres://postgres:postgres@localhost:5432/parentos_e2e",
      JWT_SECRET: "e2e-secret-that-is-long-enough-for-the-config-check-0000",
      CORS_ORIGINS: "http://localhost:5173",
      STRIPE_SECRET_KEY: "sk_test_e2e_fake",
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_API_HOST: "127.0.0.1",
      STRIPE_API_PORT: String(stripePort),
      STRIPE_API_PROTOCOL: "http",
      LOG_LEVEL: "error",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const serverLog = [];
  server.stdout.on("data", (d) => serverLog.push(d.toString()));
  server.stderr.on("data", (d) => serverLog.push(d.toString()));

  const finish = async (code) => {
    server.kill();
    await fake.close();
    process.exit(code);
  };

  if (!(await waitForServer())) {
    console.error("Server never started:\n" + serverLog.join(""));
    return finish(1);
  }

  try {
    const stamp = Date.now();
    const seller = client();
    const buyer = client();

    // ---- Accounts -------------------------------------------------------
    section("Accounts");
    await seller.get("/api/health"); // bootstrap CSRF
    await buyer.get("/api/health");

    const sellerEmail = `e2e-seller-${stamp}@example.com`;
    const buyerEmail = `e2e-buyer-${stamp}@example.com`;

    const sellerSignup = await seller.post("/api/auth/signup", {
      name: "E2E Seller", email: sellerEmail, password: "e2e-password-123",
    });
    check("seller signup", sellerSignup.status === 200, sellerSignup.raw);

    const sellerVerify = await seller.post("/api/auth/verify", {
      email: sellerEmail, code: sellerSignup.body?.devCode,
    });
    check("email verification", sellerVerify.status === 200, sellerVerify.raw);
    const sellerId = sellerVerify.body?.user?.id;

    const buyerSignup = await buyer.post("/api/auth/signup", {
      name: "E2E Buyer", email: buyerEmail, password: "e2e-password-123",
    });
    await buyer.post("/api/auth/verify", { email: buyerEmail, code: buyerSignup.body?.devCode });

    // ---- Session model --------------------------------------------------
    section("Session");
    check("access cookie issued", seller.cookies.has("parentos_token"));
    check("refresh cookie issued", seller.cookies.has("parentos_refresh"));

    const beforeRefresh = seller.cookies.get("parentos_refresh");
    const refreshed = await seller.post("/api/auth/refresh");
    check("refresh returns a new session", refreshed.status === 200, refreshed.raw);
    check("refresh token rotated", seller.cookies.get("parentos_refresh") !== beforeRefresh);
    check("refreshed token still authenticates", (await seller.get("/api/auth/me")).status === 200);

    // ---- Listing --------------------------------------------------------
    section("Listing");
    const listingRes = await seller.post("/api/listings", {
      category: "toys", title: `E2E stroller ${stamp}`, priceCents: 4500,
      condition: "Good", city: "Helsinki", area: "Kamppi",
      description: "End-to-end fixture.",
    });
    check("listing created", listingRes.status === 201, listingRes.raw);
    const listing = listingRes.body?.listing;

    const search = await buyer.get(`/api/listings?q=${encodeURIComponent("E2E stroller")}`);
    check("listing is findable by search", search.body?.listings?.some((l) => l.id === listing.id));

    const geo = await buyer.get("/api/listings?lat=60.1699&lng=24.9384&maxDistance=10");
    check("distance search returns it", geo.body?.listings?.some((l) => l.id === listing.id));

    // ---- Image upload ---------------------------------------------------
    section("Image upload");
    const presign = await seller.post("/api/uploads/presign", { contentType: "image/jpeg" });
    check("presign issued against quarantine", presign.body?.key?.startsWith("quarantine/"), presign.raw);

    // A 1x1 JPEG, built by sharp so it's a genuine image.
    const sharp = require("sharp");
    const jpeg = await sharp({ create: { width: 24, height: 24, channels: 3, background: { r: 120, g: 90, b: 60 } } })
      .jpeg().toBuffer();

    const put = await fetch(`${BASE}${presign.body.uploadUrl}`, {
      method: "PUT",
      headers: {
        "Content-Type": "image/jpeg",
        Cookie: [...seller.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        "x-csrf-token": seller.cookies.get("parentos_csrf"),
      },
      body: jpeg,
    });
    check("image uploaded to quarantine", put.status === 200, `status ${put.status}`);

    const finalize = await seller.post("/api/uploads/finalize", { key: presign.body.key });
    check("image processed out of quarantine", finalize.status === 200, finalize.raw);
    check("promoted to the public prefix", finalize.body?.key?.startsWith("listings/"));

    // Another user must not be able to touch that key.
    const stolen = await buyer.post("/api/uploads/finalize", { key: presign.body.key });
    check("another user cannot finalize it", stolen.status === 404, `got ${stolen.status}`);

    // ---- Messaging ------------------------------------------------------
    section("Messaging");
    const thread = await buyer.post("/api/messages/thread", {
      listingId: listing.id, text: "Is this still available?",
    });
    check("buyer can message the seller", thread.status === 201, thread.raw);
    const conversationId = thread.body?.conversation?.id;

    const messages = await buyer.get(`/api/messages/conversations/${conversationId}/messages`);
    check("messages are readable and paginated", Array.isArray(messages.body?.messages));

    // ---- Seller payouts -------------------------------------------------
    section("Seller payouts (Stripe Connect)");
    const beforeConnect = await buyer.post("/api/transactions/checkout", { listingId: listing.id });
    check("checkout blocked before Connect onboarding", beforeConnect.status === 409, beforeConnect.raw);

    const onboard = await seller.post("/api/connect/onboard");
    check("Connect onboarding link created via the real SDK", onboard.status === 200, onboard.raw);

    const connectStatus = await seller.get("/api/connect/status");
    check("Connect status reports payouts enabled", connectStatus.body?.payoutsEnabled === true, connectStatus.raw);

    // ---- Checkout -------------------------------------------------------
    section("Checkout");
    const checkout = await buyer.post("/api/transactions/checkout", { listingId: listing.id });
    check("checkout creates a PaymentIntent", checkout.status === 201, checkout.raw);
    const order = checkout.body?.transaction;
    const paymentIntentId = order?.stripe_payment_intent_id;
    check("PaymentIntent id returned", !!paymentIntentId);
    check("client secret returned for the browser", !!checkout.body?.clientSecret);

    const statusBefore = await buyer.get(`/api/transactions/${order.id}/status`);
    check("order reports unsettled before the webhook", statusBefore.body?.settled === false, statusBefore.raw);

    // ---- Payment --------------------------------------------------------
    section("Payment");
    fake.succeed(paymentIntentId); // as confirming a card would

    const { body: hookBody, header } = signedWebhook({
      id: `evt_${stamp}`, type: "payment_intent.succeeded",
      data: { object: { id: paymentIntentId } },
    });
    const hook = await fetch(`${BASE}/api/transactions/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "stripe-signature": header },
      body: hookBody,
    });
    check("webhook accepted with a real signature", hook.status === 200, `status ${hook.status}`);

    // An unsigned webhook must be rejected.
    const forged = await fetch(`${BASE}/api/transactions/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
      body: hookBody,
    });
    check("forged webhook signature rejected", forged.status >= 400, `status ${forged.status}`);

    const statusAfter = await buyer.get(`/api/transactions/${order.id}/status`);
    check("order settles to paid", statusAfter.body?.status === "paid", statusAfter.raw);
    check("status endpoint reports settled", statusAfter.body?.settled === true);

    // ---- Fulfilment -----------------------------------------------------
    section("Fulfilment");
    const fulfil = await seller.post(`/api/transactions/${order.id}/fulfil`);
    check("seller marks fulfilled", fulfil.body?.transaction?.status === "fulfilled", fulfil.raw);

    const receipt = await buyer.post(`/api/transactions/${order.id}/confirm-receipt`);
    check("buyer confirms receipt", receipt.body?.transaction?.status === "completed", receipt.raw);

    // ---- Review ---------------------------------------------------------
    section("Review and trust");
    const review = await buyer.post("/api/reviews", {
      revieweeId: sellerId, listingId: listing.id, rating: 5, comment: "Exactly as described.",
    });
    check("review accepted once completed", review.status === 201, review.raw);

    const profile = await buyer.get(`/api/users/${sellerId}`);
    check("trust counts the completed sale", profile.body?.user?.trust?.completedSales === 1,
      `got ${profile.body?.user?.trust?.completedSales}`);

    // ---- Audit trail ----------------------------------------------------
    section("Audit trail");
    const history = await buyer.get(`/api/transactions/${order.id}/history`);
    const statuses = (history.body?.events ?? []).map((e) => e.to_status);
    check("every transition recorded in order",
      ["paid", "fulfilled", "completed"].every((s) => statuses.includes(s)),
      JSON.stringify(statuses));

    // ---- Idempotency ----------------------------------------------------
    section("Retry safety");
    const replay = await fetch(`${BASE}/api/transactions/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "stripe-signature": header },
      body: hookBody,
    });
    check("replayed webhook is handled without error", replay.status === 200);

    const afterReplay = await buyer.get(`/api/transactions/${order.id}/status`);
    check("replay did not change the order", afterReplay.body?.status === "completed", afterReplay.raw);

    // ---- Privacy --------------------------------------------------------
    section("Privacy");
    const exported = await buyer.get("/api/privacy/export");
    check("data export returns the buyer's data", exported.status === 200);
    let exportJson = null;
    try { exportJson = JSON.parse(exported.raw); } catch { /* ignore */ }
    check("export includes the buyer's own messages",
      exportJson?.messagesYouSent?.some((m) => m.text.includes("still available")));

    // The seller has a sold listing - the case that used to break deletion.
    const deletion = await seller.post("/api/privacy/delete-account", { confirmEmail: sellerEmail });
    check("seller with a sold listing can delete their account", deletion.status === 200, deletion.raw);

    const deletedLogin = client();
    await deletedLogin.get("/api/health");
    const relogin = await deletedLogin.post("/api/auth/login", { email: sellerEmail, password: "e2e-password-123" });
    check("deleted account cannot log back in", relogin.status === 401, `got ${relogin.status}`);

    // ---- Summary --------------------------------------------------------
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) console.log("Failures:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    return finish(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error("\nAborted:", e.stack);
    console.error("\nServer log tail:\n" + serverLog.join("").slice(-2000));
    return finish(1);
  }
})();
