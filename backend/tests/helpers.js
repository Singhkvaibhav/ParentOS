const request = require("supertest");
const { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } = require("../middleware/csrf");

// Returns a supertest agent that behaves like a real browser: it persists
// cookies across requests AND echoes the CSRF cookie back as a header on
// state-changing requests, the same double-submit the frontend does (see
// frontend/src/services/api.js).
//
// Without this, every POST/PATCH/DELETE in the test suite would be
// (correctly) rejected with 403 - the tests would be asserting against
// CSRF rejections rather than the behaviour they're actually about.
async function csrfAgent(app) {
  const agent = request.agent(app);
  // Any request issues the CSRF cookie; a cheap GET is the natural way to
  // bootstrap one, exactly like the frontend's ensureCsrfToken().
  const res = await agent.get("/api/health");

  const setCookie = res.headers["set-cookie"] || [];
  const csrfCookie = setCookie.find((c) => c.startsWith(`${CSRF_COOKIE_NAME}=`));
  const token = csrfCookie ? decodeURIComponent(csrfCookie.split("=")[1].split(";")[0]) : null;

  // Wrap the mutating verbs so callers don't have to remember the header.
  for (const method of ["post", "patch", "put", "delete"]) {
    const original = agent[method].bind(agent);
    agent[method] = (...args) => original(...args).set(CSRF_HEADER_NAME, token);
  }

  return agent;
}

// Signs up and verifies a fresh user, returning a CSRF-aware agent already
// carrying the session cookie from verification - so tests can just do
// `agent.get(...)` / `agent.post(...)` for authenticated requests.
//
// Checks both responses explicitly rather than trusting them - neither
// used to be checked, which meant a signup or verify that silently failed
// (rate limiting, a transient error, an already-used email) produced an
// agent with no session cookie at all. That agent still LOOKED usable, so
// the actual failure only ever surfaced several calls later, as an
// unrelated-looking 401 deep inside some other helper (e.g.
// createListing) - exactly what happened in moderation.test.js: this
// function's own failure came back as "listing creation failed: 401 Not
// logged in" from a completely different function.
async function createVerifiedUser(app, { name = "Test User", email, password = "testpass123" } = {}) {
  const uniqueEmail = email || `user-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const agent = await csrfAgent(app);
  const signupRes = await agent.post("/api/v1/auth/signup").send({ name, email: uniqueEmail, password });
  if (signupRes.status !== 200) {
    throw new Error(`createVerifiedUser: signup failed for ${uniqueEmail}: ${signupRes.status} ${JSON.stringify(signupRes.body)}`);
  }
  const code = signupRes.body.devCode;
  const verifyRes = await agent.post("/api/v1/auth/verify").send({ email: uniqueEmail, code });
  if (verifyRes.status !== 200) {
    throw new Error(`createVerifiedUser: verify failed for ${uniqueEmail} (code ${code}): ${verifyRes.status} ${JSON.stringify(verifyRes.body)}`);
  }
  return { agent, user: verifyRes.body.user, email: uniqueEmail, password };
}

// Marks a user as payout-ready (a completed Stripe Connect onboarding).
// Checkout now refuses to charge a buyer when the seller can't actually
// receive the money (see transactionsService), so any test involving a
// purchase needs its seller in this state - the same as reality, where a
// seller must finish onboarding before their items are buyable.
async function makeSellerPayoutReady(userId) {
  const { query } = require("../db");
  await query(
    `UPDATE users SET stripe_connect_account_id = $1, connect_charges_enabled = true, connect_payouts_enabled = true
     WHERE id = $2`,
    [`acct_test_${userId}`, userId]
  );
}

// Creates a listing via the real API and returns it. Centralized here in
// place of the near-identical copy this used to have in 14 different test
// files, so every caller gets the same clear failure if creation itself
// ever fails, instead of each file's own copy crashing confusingly a line
// later on `res.body.listing.seller_id` of an undefined listing (this is
// exactly what happened in privacy.test.js - see its git history).
//
// `payoutReady` defaults to true (checkout refuses to charge a buyer when
// the seller can't actually receive the money, so most callers need it);
// pass `payoutReady: false` for tests that never touch checkout and don't
// need the extra Connect-account setup query.
async function createListing(sellerAgent, { payoutReady = true, ...overrides } = {}) {
  const res = await sellerAgent.post("/api/v1/listings").send({
    category: "toys", title: "Test listing", priceCents: 1000, condition: "Good", city: "Helsinki", area: "Kamppi",
    ...overrides,
  });
  if (!res.body.listing) {
    throw new Error(`listing creation failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  if (payoutReady) await makeSellerPayoutReady(res.body.listing.seller_id);
  return res.body.listing;
}

module.exports = { createVerifiedUser, csrfAgent, makeSellerPayoutReady, createListing };
