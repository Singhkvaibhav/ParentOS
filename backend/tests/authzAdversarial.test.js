require("../tests/setupEnv");

// A dedicated, penetration-test-style pass over cross-user authorization -
// "User A attacks User B's X" - run as a final layer on top of the
// substantial coverage already spread across listings/transactions/
// messages/notifications/directupload/security/moderation/lifecycle tests.
//
// This file exists to close the SPECIFIC gaps a full audit against that
// existing coverage found, not to re-prove what's already tested
// elsewhere. In particular, these were found to already be well covered
// and are deliberately NOT repeated here:
//   - transaction cross-user access, wrong-role actions (buyer-only /
//     seller-only), checkout against a moderated listing: tests/
//     transactions.test.js, tests/lifecycle.test.js, tests/orderhistory.test.js
//   - message/conversation cross-user reply and read access: tests/
//     messages.test.js, tests/hardening.test.js
//   - notification cross-user mark-read and push-token unregister: tests/
//     notifications.test.js, tests/push.test.js
//   - upload ownership (presign/PUT/finalize): tests/directupload.test.js
//     - the most thoroughly covered IDOR surface in the suite already
//   - session revocation via session_version: tests/security.test.js
//
// And three scenarios from the original checklist aren't testable because
// the attack surface doesn't exist:
//   - "User A reads User B's privacy export": GET /privacy/export takes no
//     user-id parameter at all - it always operates on req.user.id (see
//     privacy/routes.js). There's nothing to pass a victim's id into.
//   - "User A manages User B's sessions": listSessions/revokeSession
//     (services/tokenService.js) are not wired to any route - the only
//     exposed session-ending endpoints (logout, logout-everywhere) act on
//     the caller's own session/refresh token, with no target-user
//     parameter to attack.
//   - "suspended user blocked from protected actions": there is no
//     suspension/ban status anywhere in the schema (only is_admin and the
//     unrelated user-to-user block list) - nothing to test against.
// If any of the three above gets built later, it needs its own ownership
// check AND its own adversarial test here.
jest.mock("../ai/controller", () => ({
  AiUnavailableError: class extends Error {},
  getAutoReply: jest.fn().mockResolvedValue("Mocked auto-reply."),
}));

const app = require("../server");
const { query } = require("../db");
const { resetDb } = require("./dbReset");
const { createVerifiedUser, csrfAgent, createListing: createListingBase } = require("./helpers");

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
});

async function createListing(sellerAgent, overrides = {}) {
  return createListingBase(sellerAgent, {
    category: "toys", title: "Adversarial test toy", priceCents: 1000, payoutReady: false, ...overrides,
  });
}

async function makeAdmin(userId) {
  await query("UPDATE users SET is_admin = true WHERE id = $1", [userId]);
}

// (gap #1) requireOwnedListing (services/listingsService.js) backs update,
// remove, reserve, markSold and relist identically - but only /reserve had
// a cross-owner test. A regression scoped to just one of the other four
// would previously have shipped unnoticed.
describe("adversarial: a non-owner cannot mutate someone else's listing", () => {
  let seller, attacker, listing;

  beforeAll(async () => {
    seller = await createVerifiedUser(app, { email: "advlistingseller@example.com" });
    attacker = await createVerifiedUser(app, { email: "advlistingattacker@example.com" });
    listing = await createListing(seller.agent);
  });

  test("PATCH", async () => {
    const res = await attacker.agent.patch(`/api/v1/listings/${listing.id}`).send({ title: "Hijacked" });
    expect(res.status).toBe(403);
  });

  test("DELETE", async () => {
    const res = await attacker.agent.delete(`/api/v1/listings/${listing.id}`);
    expect(res.status).toBe(403);
  });

  test("mark sold", async () => {
    const res = await attacker.agent.post(`/api/v1/listings/${listing.id}/sold`);
    expect(res.status).toBe(403);
  });

  test("relist", async () => {
    // requireOwnedListing runs before the state-transition check inside
    // setStatus (see listingsService.js), so ownership is rejected first
    // regardless of the listing's current status - no need to get it into
    // "sold" (relist's only valid source state) for this to be meaningful.
    const res = await attacker.agent.post(`/api/v1/listings/${listing.id}/relist`);
    expect(res.status).toBe(403);
  });
});

// (gap #4) markConversationRead shares the identical roleOf() guard as
// reply()/listMessages() (both tested elsewhere), but wasn't itself
// exercised cross-user.
describe("adversarial: a non-participant cannot mark someone else's conversation read", () => {
  test("POST /messages/conversations/:id/read", async () => {
    const seller = await createVerifiedUser(app, { email: "advconvoseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "advconvobuyer@example.com" });
    const attacker = await createVerifiedUser(app, { email: "advconvoattacker@example.com" });
    const listing = await createListing(seller.agent);

    const started = await buyer.agent.post("/api/v1/messages/thread").send({ listingId: listing.id, text: "Interested" });
    const conversationId = started.body.conversation.id;

    const res = await attacker.agent.post(`/api/v1/messages/conversations/${conversationId}/read`);
    expect(res.status).toBe(403);
  });
});

// (gap #2) Every one of these routes checks is_admin correctly in the
// service layer (confirmed by reading moderationService.js/
// reconciliationService.js) - what was missing was a test proving a
// signed-in NON-admin actually gets rejected by each one specifically,
// rather than only ever being called by an admin agent in other files.
describe("adversarial: non-admin rejected from every admin-only moderation/reconciliation route", () => {
  let admin, nonAdmin, listing, report;

  beforeAll(async () => {
    admin = await createVerifiedUser(app, { email: "advadmin@example.com" });
    await makeAdmin(admin.user.id);
    nonAdmin = await createVerifiedUser(app, { email: "advnonadmin@example.com" });
    const seller = await createVerifiedUser(app, { email: "advadminseller@example.com" });
    const reporter = await createVerifiedUser(app, { email: "advadminreporter@example.com" });
    listing = await createListing(seller.agent);

    const reportRes = await reporter.agent.post("/api/v1/moderation/reports").send({
      listingId: listing.id, reason: "prohibited",
    });
    report = reportRes.body.report;

    // Admin takes it down for real, so restore/retry have a real row to
    // act on - a 403 that only happens because the target doesn't exist
    // would be the wrong reason for the test to pass.
    await admin.agent.post(`/api/v1/moderation/listings/${listing.id}/takedown`).send({ reason: "Test takedown" });
  });

  test("POST /moderation/listings/:id/restore", async () => {
    const res = await nonAdmin.agent.post(`/api/v1/moderation/listings/${listing.id}/restore`);
    expect(res.status).toBe(403);
  });

  test("POST /moderation/reports/:id/resolve", async () => {
    const res = await nonAdmin.agent.post(`/api/v1/moderation/reports/${report.id}/resolve`).send({ status: "dismissed" });
    expect(res.status).toBe(403);
  });

  test("GET /moderation/unsettled", async () => {
    const res = await nonAdmin.agent.get("/api/v1/moderation/unsettled");
    expect(res.status).toBe(403);
  });

  test("POST /moderation/unsettled/:id/retry", async () => {
    const res = await nonAdmin.agent.post("/api/v1/moderation/unsettled/1/retry");
    expect(res.status).toBe(403);
  });

  test("POST /reconciliation/issues/:id/resolve", async () => {
    const res = await nonAdmin.agent.post("/api/v1/reconciliation/issues/1/resolve").send({ status: "resolved" });
    expect(res.status).toBe(403);
  });
});

// (gap #3) tests/privacy.test.js already proves a deleted account can't
// log back in with its password. That's a different claim from this one:
// an access token issued and still live BEFORE deletion must stop working
// immediately, server-side - not just "the browser that deleted its own
// account happened to lose its cookie". Two independent logins (mirroring
// tests/security.test.js's logout-everywhere test) prove it's the account
// deletion itself invalidating every session, not a side effect of the
// deleting request's own response.
describe("adversarial: an access token issued before account deletion is rejected after deletion", () => {
  test("a second, untouched device's token stops working once the account is deleted from a different device", async () => {
    const { email, password } = await createVerifiedUser(app, { email: "advdeleteme@example.com" });

    const deviceA = await csrfAgent(app);
    await deviceA.post("/api/v1/auth/login").send({ email, password });
    const deviceB = await csrfAgent(app);
    await deviceB.post("/api/v1/auth/login").send({ email, password });

    expect((await deviceB.get("/api/v1/auth/me")).status).toBe(200);

    const del = await deviceA.post("/api/v1/privacy/delete-account").send({ confirmEmail: email });
    expect(del.status).toBe(200);

    // deviceB never touched the delete-account call and never received a
    // clear-cookie response - its old token is being replayed as-is.
    const after = await deviceB.get("/api/v1/auth/me");
    expect(after.status).toBe(401);
  });
});
