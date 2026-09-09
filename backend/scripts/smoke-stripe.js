#!/usr/bin/env node
// End-to-end smoke test against REAL Stripe test mode.
//
// The Jest suite mocks the Stripe SDK, which is right for unit and
// integration testing but leaves a gap it structurally cannot cover:
// real webhook signature verification, real PaymentIntent state
// transitions, real Connect account behaviour, and the actual shape of
// Stripe's responses. Those only fail against the real API, and they fail
// in production if nobody checks.
//
// This walks the full chain against a running backend and a real test-mode
// Stripe account:
//
//   signup -> verify -> listing -> checkout -> confirm PaymentIntent
//     -> webhook -> paid -> fulfil -> confirm receipt -> completed -> review
//
// PREREQUISITES
//   1. Backend running:            npm start
//   2. Test-mode keys in .env:     STRIPE_SECRET_KEY=sk_test_...
//   3. Webhooks forwarded locally, in another terminal:
//        stripe listen --forward-to localhost:4000/api/transactions/webhook
//      and put the printed whsec_... in STRIPE_WEBHOOK_SECRET.
//
// Run with: node scripts/smoke-stripe.js
require("dotenv").config();

const BASE = process.env.SMOKE_BASE_URL || "http://localhost:4000";
const KEY = process.env.STRIPE_SECRET_KEY || "";

// Refusing to run against a live key is the single most important line in
// this file. A smoke test that creates real charges against real customers
// because someone had production credentials loaded would be far worse
// than having no smoke test at all.
if (!KEY.startsWith("sk_test_")) {
  console.error(
    KEY
      ? "REFUSING TO RUN: STRIPE_SECRET_KEY is not a test-mode key (sk_test_...).\n" +
        "This script creates payments. It will not run against live credentials."
      : "STRIPE_SECRET_KEY is not set. Put a test-mode key in .env first."
  );
  process.exit(1);
}

const stripe = require("stripe")(KEY);

let cookies = "";
let csrf = "";

function stepLog(n, msg) {
  console.log(`\n[${n}] ${msg}`);
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookies ? { Cookie: cookies } : {}),
      ...(csrf ? { "x-csrf-token": csrf } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const setCookie = res.headers.getSetCookie?.() || [];
  if (setCookie.length) {
    // Crude jar - enough for a linear script.
    for (const c of setCookie) {
      const [pair] = c.split(";");
      const [name] = pair.split("=");
      cookies = cookies
        .split("; ")
        .filter((existing) => existing && !existing.startsWith(`${name}=`))
        .concat(pair)
        .join("; ");
      if (name === "parentos_csrf") csrf = pair.split("=")[1];
    }
  }

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

// The webhook arrives asynchronously via `stripe listen`, so the script has
// to wait for it rather than assume it landed. If this times out, the
// forwarding isn't running - which is exactly the misconfiguration worth
// catching before production.
async function waitForStatus(transactionId, wanted, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { transactions } = await api("/api/transactions/mine");
    const t = transactions.find((x) => x.id === transactionId);
    if (t && t.status === wanted) return t;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `Timed out waiting for transaction ${transactionId} to reach '${wanted}'.\n` +
    "Is `stripe listen --forward-to localhost:4000/api/transactions/webhook` running,\n" +
    "and is STRIPE_WEBHOOK_SECRET set to the whsec_... it printed?"
  );
}

(async () => {
  const stamp = Date.now();
  const sellerEmail = `smoke-seller-${stamp}@example.com`;
  const buyerEmail = `smoke-buyer-${stamp}@example.com`;

  stepLog(1, "Bootstrapping CSRF");
  await api("/api/health");

  stepLog(2, `Creating seller ${sellerEmail}`);
  const sellerSignup = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "Smoke Seller", email: sellerEmail, password: "smokepass123" },
  });
  await api("/api/auth/verify", { method: "POST", body: { email: sellerEmail, code: sellerSignup.devCode } });

  stepLog(3, "Creating a listing");
  const { listing } = await api("/api/listings", {
    method: "POST",
    body: {
      category: "toys", title: `Smoke test item ${stamp}`, priceCents: 2500,
      condition: "Good", city: "Helsinki", area: "Kamppi",
      description: "Created by scripts/smoke-stripe.js",
    },
  });
  console.log(`    listing #${listing.id}`);

  console.log(
    "\n    NOTE: the seller needs a Connect account with charges enabled or\n" +
    "    checkout will (correctly) refuse. Complete onboarding at\n" +
    `    ${BASE}/api/connect/onboard or use an already-onboarded test seller.`
  );

  stepLog(4, `Creating buyer ${buyerEmail}`);
  cookies = ""; csrf = "";
  await api("/api/health");
  const buyerSignup = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "Smoke Buyer", email: buyerEmail, password: "smokepass123" },
  });
  await api("/api/auth/verify", { method: "POST", body: { email: buyerEmail, code: buyerSignup.devCode } });

  stepLog(5, "Checkout - creating a real PaymentIntent");
  const { transaction, clientSecret } = await api("/api/transactions/checkout", {
    method: "POST",
    body: { listingId: listing.id, deliveryMethod: "pickup" },
  });
  console.log(`    transaction #${transaction.id}, intent ${transaction.stripe_payment_intent_id}`);
  if (!clientSecret) console.log("    (no clientSecret returned - check the checkout response shape)");

  stepLog(6, "Confirming the PaymentIntent with a test card");
  await stripe.paymentIntents.confirm(transaction.stripe_payment_intent_id, {
    payment_method: "pm_card_visa", // Stripe's always-succeeds test method
    return_url: `${BASE}/`,
  });

  stepLog(7, "Waiting for the webhook to settle the order");
  await waitForStatus(transaction.id, "paid");
  console.log("    status -> paid (webhook verified a real signature)");

  stepLog(8, "Seller marks it fulfilled");
  cookies = ""; csrf = "";
  await api("/api/health");
  await api("/api/auth/login", { method: "POST", body: { email: sellerEmail, password: "smokepass123" } });
  await api(`/api/transactions/${transaction.id}/fulfil`, { method: "POST" });

  stepLog(9, "Buyer confirms receipt");
  cookies = ""; csrf = "";
  await api("/api/health");
  await api("/api/auth/login", { method: "POST", body: { email: buyerEmail, password: "smokepass123" } });
  await api(`/api/transactions/${transaction.id}/confirm-receipt`, { method: "POST" });

  stepLog(10, "Buyer leaves a review");
  await api("/api/reviews", {
    method: "POST",
    body: { revieweeId: listing.seller_id, listingId: listing.id, rating: 5, comment: "Smoke test" },
  });

  stepLog(11, "Reconciling against Stripe");
  const { runReconciliation } = require("../services/reconciliationService");
  const recon = await runReconciliation();
  console.log(`    checked ${recon.checked}, discrepancies ${recon.issuesFound}`);
  if (recon.issuesFound > 0) {
    throw new Error("Reconciliation found discrepancies after a clean run - investigate before shipping.");
  }

  console.log("\nAll steps passed against real Stripe test mode.\n");
  process.exit(0);
})().catch((e) => {
  console.error(`\nSMOKE TEST FAILED:\n${e.message}\n`);
  process.exit(1);
});
