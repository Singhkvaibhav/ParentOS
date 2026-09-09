// Full purchase journey against a RUNNING server and a REAL database:
//
//   signup -> verify -> list -> checkout -> webhook -> paid
//          -> fulfil -> confirm receipt -> completed -> review
//
// This exists because the Jest suite mocks Stripe at the module boundary.
// That's correct for unit and integration tests, but it means the suite
// cannot catch anything in the wiring between the process and Stripe:
// wrong API version, a key with the wrong permissions, a webhook signature
// secret that doesn't match, a Connect account that can't accept charges.
// Those only appear against the real API.
//
// Two modes:
//
//   STRIPE_MODE=real   Requires STRIPE_SECRET_KEY (sk_test_...) and a
//                      Stripe CLI listener forwarding webhooks:
//                        stripe listen --forward-to localhost:4000/api/transactions/webhook
//                      Exercises the genuine Stripe round trip.
//
//   STRIPE_MODE=local  (default) Drives the same HTTP endpoints but posts
//                      the payment_intent.succeeded webhook directly.
//                      Verifies every application-side transition; does NOT
//                      verify anything about Stripe itself. Useful in CI
//                      and in environments with no outbound network.
//
// Usage: node scripts/journey.js
require("dotenv").config();

const BASE = process.env.JOURNEY_BASE_URL || "http://localhost:4000";
const MODE = process.env.STRIPE_MODE || "local";

let passed = 0;
let failed = 0;

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed += 1;
  } else {
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
    failed += 1;
  }
}

// Minimal cookie-jar client: the app uses httpOnly auth cookies plus a
// CSRF double-submit token, so a plain fetch won't get past the first
// state-changing request.
function makeClient() {
  const cookies = new Map();

  function cookieHeader() {
    return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async function request(method, path, body) {
    const headers = { "Content-Type": "application/json" };
    if (cookies.size) headers.Cookie = cookieHeader();
    const csrf = cookies.get("parentos_csrf");
    if (csrf) headers["x-csrf-token"] = csrf;

    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const idx = pair.indexOf("=");
      cookies.set(pair.slice(0, idx), pair.slice(idx + 1));
    }

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    return { status: res.status, body: json, raw: text };
  }

  return {
    get: (p) => request("GET", p),
    post: (p, b) => request("POST", p, b),
    del: (p) => request("DELETE", p),
  };
}

async function signUpVerified(client, name, email) {
  // Bootstraps the CSRF cookie.
  await client.get("/api/health");
  const signup = await client.post("/api/auth/signup", { name, email, password: "journey-pass-123" });
  if (signup.status === 429) {
    // The signup limiter is per-IP and in-memory, so repeated journey runs
    // against one server process will trip it. That's the limiter working,
    // not a failure - but it needs saying, or it reads as a broken signup.
    throw new Error(
      "signup rate-limited (429). The per-IP signup limiter is doing its job; " +
      "restart the server to reset its in-memory counter, or wait out the window."
    );
  }
  if (signup.status !== 200) throw new Error(`signup failed: ${signup.status} ${signup.raw}`);

  // devCode is only returned when SMTP isn't configured, which is exactly
  // the situation this script runs in.
  const code = signup.body?.devCode;
  if (!code) throw new Error("No devCode returned - configure SMTP off, or verify manually.");

  const verify = await client.post("/api/auth/verify", { email, code });
  if (verify.status !== 200) throw new Error(`verify failed: ${verify.status} ${verify.raw}`);
  return verify.body.user;
}

(async () => {
  console.log(`\nJourney against ${BASE} (STRIPE_MODE=${MODE})\n`);

  const stamp = Date.now();
  const seller = makeClient();
  const buyer = makeClient();

  console.log("Accounts");
  const sellerUser = await signUpVerified(seller, "Journey Seller", `journey-seller-${stamp}@example.com`);
  const buyerUser = await signUpVerified(buyer, "Journey Buyer", `journey-buyer-${stamp}@example.com`);
  check("seller and buyer created and verified", !!sellerUser.id && !!buyerUser.id);

  console.log("\nListing");
  const listingRes = await seller.post("/api/listings", {
    category: "toys", title: `Journey stroller ${stamp}`, priceCents: 2500,
    condition: "Good", city: "Helsinki", area: "Kamppi",
    description: "End-to-end journey fixture.",
  });
  check("listing created", listingRes.status === 201, listingRes.raw);
  const listing = listingRes.body?.listing;
  if (!listing) throw new Error("Cannot continue without a listing.");

  // Checkout deliberately refuses a seller who can't receive payouts, so
  // the journey has to get past Connect onboarding.
  //
  // In local mode that's simulated by setting the same columns Connect
  // onboarding would set. This is ONLY done in local mode: in real mode
  // the seller must genuinely onboard, because whether Connect works is
  // precisely what real mode exists to test.
  if (MODE !== "real") {
    const { query, pool } = require("../db");
    await query(
      `UPDATE users SET stripe_connect_account_id = $1,
                        connect_charges_enabled = true, connect_payouts_enabled = true
       WHERE id = $2`,
      [`acct_journey_${stamp}`, sellerUser.id]
    );
    await pool.end();
    console.log("  NOTE  seller marked payout-ready (local mode only)");
  }

  console.log("\nCheckout");
  const checkout = await buyer.post("/api/transactions/checkout", { listingId: listing.id });
  // A seller with no Connect account is refused on purpose - money must
  // never be collected for someone who can't be paid.
  if (checkout.status === 409 || checkout.status === 400) {
    console.log(`  NOTE  checkout refused (${checkout.status}): ${checkout.body?.error}`);
    console.log("        Expected unless the seller has completed Stripe Connect onboarding.");
    console.log("        Run with a Connect-onboarded seller to exercise the full flow.");
  }
  // No Stripe key means the one thing this script uniquely tests - the
  // real round trip to Stripe - cannot run. That's a missing prerequisite,
  // not a defect, so it exits with a distinct code (2) rather than
  // reporting a failure that would be indistinguishable from a real one.
  if (checkout.body?.error?.includes("Stripe isn't configured")) {
    console.log("\n  SKIP  No STRIPE_SECRET_KEY configured.");
    console.log("        This script exists to exercise the real Stripe round trip:");
    console.log("        wrong API version, bad key permissions, mismatched webhook secret.");
    console.log("        Those cannot be caught with a mock, so there is nothing useful to run.");
    console.log("        Set a sk_test_... key in backend/.env and re-run.");
    console.log("        The application-side chain is covered by `npm test`.\n");
    process.exit(2);
  }

  check("checkout returns a payment intent", !!checkout.body?.transaction?.stripe_payment_intent_id, checkout.raw);
  const transaction = checkout.body?.transaction;
  if (!transaction) {
    console.log("\nStopping: no transaction to follow.\n");
    process.exit(failed > 0 ? 1 : 0);
  }

  console.log("\nPayment");
  if (MODE === "real") {
    console.log("  Waiting for Stripe to deliver payment_intent.succeeded via `stripe listen`...");
    console.log("  Confirm the PaymentIntent in the Stripe dashboard or with a test card.");
    let settled = false;
    for (let i = 0; i < 60 && !settled; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const mine = await buyer.get("/api/transactions/mine");
      settled = mine.body?.transactions?.some((t) => t.id === transaction.id && t.status !== "pending");
    }
    check("Stripe webhook settled the order", settled, "timed out after 2 minutes");
  } else {
    const hook = await fetch(`${BASE}/api/transactions/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "stripe-signature": "local-mode" },
      body: JSON.stringify({
        type: "payment_intent.succeeded",
        data: { object: { id: transaction.stripe_payment_intent_id } },
      }),
    });
    check("webhook accepted", hook.status === 200, `status ${hook.status}`);
  }

  const afterPay = await buyer.get("/api/transactions/mine");
  const paid = afterPay.body?.transactions?.find((t) => t.id === transaction.id);
  check("order is 'paid' after payment", paid?.status === "paid", `got ${paid?.status}`);

  console.log("\nHandover");
  const fulfil = await seller.post(`/api/transactions/${transaction.id}/fulfil`);
  check("seller marks fulfilled", fulfil.status === 200, fulfil.raw);
  check("order is 'fulfilled'", fulfil.body?.transaction?.status === "fulfilled");

  const receipt = await buyer.post(`/api/transactions/${transaction.id}/confirm-receipt`);
  check("buyer confirms receipt", receipt.status === 200, receipt.raw);
  check("order is 'completed'", receipt.body?.transaction?.status === "completed");

  console.log("\nReview");
  const review = await buyer.post("/api/reviews", {
    revieweeId: sellerUser.id, listingId: listing.id, rating: 5, comment: "Smooth journey.",
  });
  check("review accepted once the order completed", review.status === 201, review.raw);

  console.log("\nTrust");
  const profile = await buyer.get(`/api/users/${sellerUser.id}`);
  // Counts completions, not payments - a seller paid but not confirmed
  // must not accrue trust.
  check("seller credited with one completed sale", profile.body?.user?.trust?.completedSales === 1,
    `got ${profile.body?.user?.trust?.completedSales}`);

  console.log("\nAudit trail");
  const history = await buyer.get(`/api/transactions/${transaction.id}/history`);
  const statuses = (history.body?.events ?? []).map((e) => e.to_status);
  check("every transition recorded in order",
    ["paid", "fulfilled", "completed"].every((s) => statuses.includes(s)),
    `got ${JSON.stringify(statuses)}`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error("\nJourney aborted:", e.message, "\n");
  process.exit(1);
});
