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
async function createVerifiedUser(app, { name = "Test User", email, password = "testpass123" } = {}) {
  const uniqueEmail = email || `user-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const agent = await csrfAgent(app);
  const signupRes = await agent.post("/api/auth/signup").send({ name, email: uniqueEmail, password });
  const code = signupRes.body.devCode;
  const verifyRes = await agent.post("/api/auth/verify").send({ email: uniqueEmail, code });
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

module.exports = { createVerifiedUser, csrfAgent, makeSellerPayoutReady };
