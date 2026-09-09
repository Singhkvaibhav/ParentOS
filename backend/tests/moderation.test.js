const request = require("supertest");
require("../tests/setupEnv");

jest.mock("../ai/controller", () => ({
  AiUnavailableError: class extends Error {},
  getAutoReply: jest.fn().mockResolvedValue("Mocked auto-reply."),
}));

const app = require("../server");
const { query } = require("../db");
const { resetDb } = require("./dbReset");
const { createVerifiedUser } = require("./helpers");

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
});

async function createListing(sellerAgent, overrides = {}) {
  const res = await sellerAgent.post("/api/listings").send({
    category: "toys", title: "Moderation test toy", priceCents: 1000, condition: "Good", city: "Helsinki", area: "Kamppi", ...overrides,
  });
  return res.body.listing;
}

async function makeAdmin(userId) {
  await query("UPDATE users SET is_admin = true WHERE id = $1", [userId]);
}

describe("reporting", () => {
  test("a signed-in user can report a listing", async () => {
    const seller = await createVerifiedUser(app, { email: "repseller@example.com" });
    const reporter = await createVerifiedUser(app, { email: "reporter@example.com" });
    const listing = await createListing(seller.agent);

    const res = await reporter.agent.post("/api/moderation/reports").send({
      listingId: listing.id, reason: "safety", detail: "Car seat model was recalled",
    });
    expect(res.status).toBe(201);
    expect(res.body.report.status).toBe("open");
  });

  test("reporting requires authentication", async () => {
    const res = await request(app).post("/api/moderation/reports").send({ listingId: 1, reason: "spam" });
    expect(res.status).toBe(403); // CSRF rejects before auth - either way, not accepted
  });

  test("a report must name exactly one target", async () => {
    const reporter = await createVerifiedUser(app, { email: "twotargets@example.com" });
    const res = await reporter.agent.post("/api/moderation/reports").send({
      listingId: 1, reportedUserId: 2, reason: "spam",
    });
    expect(res.status).toBe(400);
  });

  test("an invalid reason is rejected", async () => {
    const seller = await createVerifiedUser(app, { email: "badreasonseller@example.com" });
    const reporter = await createVerifiedUser(app, { email: "badreason@example.com" });
    const listing = await createListing(seller.agent);
    const res = await reporter.agent.post("/api/moderation/reports").send({ listingId: listing.id, reason: "because" });
    expect(res.status).toBe(400);
  });

  test("you can't report yourself", async () => {
    const user = await createVerifiedUser(app, { email: "selfreport@example.com" });
    const res = await user.agent.post("/api/moderation/reports").send({ reportedUserId: user.user.id, reason: "spam" });
    expect(res.status).toBe(400);
  });

  test("duplicate open reports on the same target are rejected", async () => {
    const seller = await createVerifiedUser(app, { email: "dupreportseller@example.com" });
    const reporter = await createVerifiedUser(app, { email: "dupreporter@example.com" });
    const listing = await createListing(seller.agent);

    await reporter.agent.post("/api/moderation/reports").send({ listingId: listing.id, reason: "spam" });
    const second = await reporter.agent.post("/api/moderation/reports").send({ listingId: listing.id, reason: "spam" });
    expect(second.status).toBe(409);
  });

  test("reporting a nonexistent listing is a clean 404, not a raw constraint error", async () => {
    const reporter = await createVerifiedUser(app, { email: "ghostreport@example.com" });
    const res = await reporter.agent.post("/api/moderation/reports").send({ listingId: 999999, reason: "spam" });
    expect(res.status).toBe(404);
  });

  test("you can't report a conversation you're not part of", async () => {
    const seller = await createVerifiedUser(app, { email: "convseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "convbuyer@example.com" });
    const stranger = await createVerifiedUser(app, { email: "convstranger@example.com" });
    const listing = await createListing(seller.agent);
    const send = await buyer.agent.post("/api/messages/thread").send({ listingId: listing.id, text: "hi" });

    const res = await stranger.agent.post("/api/moderation/reports").send({
      conversationId: send.body.conversation.id, reason: "harassment",
    });
    expect(res.status).toBe(404);
  });
});

describe("blocking", () => {
  test("blocking prevents a buyer from messaging the seller", async () => {
    const seller = await createVerifiedUser(app, { email: "blockseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "blockbuyer@example.com" });
    const listing = await createListing(seller.agent);

    await seller.agent.post("/api/moderation/blocks").send({ userId: buyer.user.id });

    const res = await buyer.agent.post("/api/messages/thread").send({ listingId: listing.id, text: "hello?" });
    expect(res.status).toBe(403);
  });

  test("blocking is symmetric - the blocker also can't message the blocked user", async () => {
    const seller = await createVerifiedUser(app, { email: "symseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "symbuyer@example.com" });
    const listing = await createListing(seller.agent);

    // The BUYER blocks the seller, then tries to message them anyway.
    await buyer.agent.post("/api/moderation/blocks").send({ userId: seller.user.id });

    const res = await buyer.agent.post("/api/messages/thread").send({ listingId: listing.id, text: "hello?" });
    expect(res.status).toBe(403);
  });

  test("a block applied mid-conversation stops further replies", async () => {
    const seller = await createVerifiedUser(app, { email: "midseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "midbuyer@example.com" });
    const listing = await createListing(seller.agent);

    const send = await buyer.agent.post("/api/messages/thread").send({ listingId: listing.id, text: "first" });
    const conversationId = send.body.conversation.id;

    await seller.agent.post("/api/moderation/blocks").send({ userId: buyer.user.id });

    const res = await buyer.agent.post(`/api/messages/conversations/${conversationId}/reply`).send({ text: "again" });
    expect(res.status).toBe(403);
  });

  test("unblocking restores messaging", async () => {
    const seller = await createVerifiedUser(app, { email: "unblockseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "unblockbuyer@example.com" });
    const listing = await createListing(seller.agent);

    await seller.agent.post("/api/moderation/blocks").send({ userId: buyer.user.id });
    await seller.agent.delete(`/api/moderation/blocks/${buyer.user.id}`);

    const res = await buyer.agent.post("/api/messages/thread").send({ listingId: listing.id, text: "hi again" });
    expect(res.status).toBe(201);
  });

  test("you can't block yourself", async () => {
    const user = await createVerifiedUser(app, { email: "selfblock@example.com" });
    const res = await user.agent.post("/api/moderation/blocks").send({ userId: user.user.id });
    expect(res.status).toBe(400);
  });

  test("blocks are listable", async () => {
    const a = await createVerifiedUser(app, { email: "listblocka@example.com" });
    const b = await createVerifiedUser(app, { email: "listblockb@example.com" });
    await a.agent.post("/api/moderation/blocks").send({ userId: b.user.id });

    const res = await a.agent.get("/api/moderation/blocks");
    expect(res.body.blocks.some((u) => u.id === b.user.id)).toBe(true);
  });
});

describe("moderator actions", () => {
  test("a non-admin can't see the report queue or take listings down", async () => {
    const user = await createVerifiedUser(app, { email: "notadmin@example.com" });
    expect((await user.agent.get("/api/moderation/reports")).status).toBe(403);
    expect((await user.agent.post("/api/moderation/listings/1/takedown").send({})).status).toBe(403);
  });

  test("an admin sees open reports", async () => {
    const admin = await createVerifiedUser(app, { email: "admin1@example.com" });
    await makeAdmin(admin.user.id);
    const seller = await createVerifiedUser(app, { email: "queueseller@example.com" });
    const reporter = await createVerifiedUser(app, { email: "queuereporter@example.com" });
    const listing = await createListing(seller.agent);
    await reporter.agent.post("/api/moderation/reports").send({ listingId: listing.id, reason: "prohibited" });

    const res = await admin.agent.get("/api/moderation/reports");
    expect(res.status).toBe(200);
    expect(res.body.reports.some((r) => r.listing_id === listing.id)).toBe(true);
  });

  test("a taken-down listing disappears from browsing and can't be bought", async () => {
    const admin = await createVerifiedUser(app, { email: "admin2@example.com" });
    await makeAdmin(admin.user.id);
    const seller = await createVerifiedUser(app, { email: "takedownseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "takedownbuyer@example.com" });
    const listing = await createListing(seller.agent, { title: "Unsafe recalled item" });

    await admin.agent.post(`/api/moderation/listings/${listing.id}/takedown`).send({ reason: "Recalled product" });

    const browse = await request(app).get("/api/listings?q=Unsafe");
    expect(browse.body.listings.some((l) => l.id === listing.id)).toBe(false);

    const buyAttempt = await buyer.agent.post("/api/transactions/checkout").send({ listingId: listing.id });
    expect(buyAttempt.status).toBe(409);
  });

  // The takedown lives in its own column precisely so a seller's own
  // status actions can't clear it.
  test("a seller can't relist their way out of a takedown", async () => {
    const admin = await createVerifiedUser(app, { email: "admin3@example.com" });
    await makeAdmin(admin.user.id);
    const seller = await createVerifiedUser(app, { email: "evadeseller@example.com" });
    const listing = await createListing(seller.agent);

    await admin.agent.post(`/api/moderation/listings/${listing.id}/takedown`).send({ reason: "Prohibited" });

    // Try every seller-facing status action.
    expect((await seller.agent.post(`/api/listings/${listing.id}/sold`)).status).toBe(403);
    expect((await seller.agent.post(`/api/listings/${listing.id}/reserve`)).status).toBe(403);

    const stillHidden = await request(app).get("/api/listings");
    expect(stillHidden.body.listings.some((l) => l.id === listing.id)).toBe(false);
  });

  test("an admin can restore a listing they took down", async () => {
    const admin = await createVerifiedUser(app, { email: "admin4@example.com" });
    await makeAdmin(admin.user.id);
    const seller = await createVerifiedUser(app, { email: "restoreseller@example.com" });
    const listing = await createListing(seller.agent, { title: "Restorable item" });

    await admin.agent.post(`/api/moderation/listings/${listing.id}/takedown`).send({ reason: "Mistake" });
    await admin.agent.post(`/api/moderation/listings/${listing.id}/restore`);

    const browse = await request(app).get("/api/listings?q=Restorable");
    expect(browse.body.listings.some((l) => l.id === listing.id)).toBe(true);
  });

  test("resolving a report moves it out of the open queue", async () => {
    const admin = await createVerifiedUser(app, { email: "admin5@example.com" });
    await makeAdmin(admin.user.id);
    const seller = await createVerifiedUser(app, { email: "resolveseller@example.com" });
    const reporter = await createVerifiedUser(app, { email: "resolvereporter@example.com" });
    const listing = await createListing(seller.agent);
    const report = await reporter.agent.post("/api/moderation/reports").send({ listingId: listing.id, reason: "misleading" });

    const res = await admin.agent.post(`/api/moderation/reports/${report.body.report.id}/resolve`).send({
      status: "dismissed", note: "Description was accurate",
    });
    expect(res.status).toBe(200);

    const open = await admin.agent.get("/api/moderation/reports?status=open");
    expect(open.body.reports.some((r) => r.id === report.body.report.id)).toBe(false);
  });

  test("a resolved report allows the same reporter to file again if it recurs", async () => {
    const admin = await createVerifiedUser(app, { email: "admin6@example.com" });
    await makeAdmin(admin.user.id);
    const seller = await createVerifiedUser(app, { email: "refileseller@example.com" });
    const reporter = await createVerifiedUser(app, { email: "refilereporter@example.com" });
    const listing = await createListing(seller.agent);

    const first = await reporter.agent.post("/api/moderation/reports").send({ listingId: listing.id, reason: "spam" });
    await admin.agent.post(`/api/moderation/reports/${first.body.report.id}/resolve`).send({ status: "dismissed" });

    const second = await reporter.agent.post("/api/moderation/reports").send({ listingId: listing.id, reason: "spam" });
    expect(second.status).toBe(201);
  });
});
