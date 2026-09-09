const request = require("supertest");
require("../tests/setupEnv");

// Unit/integration tests shouldn't depend on a real external API call (or
// need a real Anthropic key) - mock the one function messagesService.js
// calls out to. jest.mock is resolved relative to THIS file but hits the
// same module cache entry regardless of which other file requires it.
jest.mock("../ai/controller", () => ({
  getAutoReply: jest.fn().mockResolvedValue("Mocked auto-reply for tests."),
}));

const app = require("../server");
const { query } = require("../db");
const { resetDb } = require("./dbReset");
const { createVerifiedUser, csrfAgent } = require("./helpers");

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
});

async function createListing(sellerAgent, overrides = {}) {
  const res = await sellerAgent.post("/api/listings").send({
    category: "toys",
    title: "Test toy",
    priceCents: 1000,
    condition: "Good",
    city: "Helsinki",
    area: "Kamppi",
    ...overrides,
  });
  return res.body.listing;
}

// Polls a condition until it's true or the timeout elapses - used to wait
// for the out-of-band AI reply (fire-and-forget from the server's point of
// view) to actually land before asserting on it.
async function waitFor(conditionFn, { timeout = 2000, interval = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await conditionFn()) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

describe("message authorization", () => {
  test("unauthenticated requests to /messages/thread are rejected", async () => {
    const getRes = await request(app).get("/api/messages/thread?listingId=1");
    const postRes = await (await csrfAgent(app)).post("/api/messages/thread").send({ listingId: 1, text: "hi" });
    expect(getRes.status).toBe(401);
    expect(postRes.status).toBe(401);
  });

  test("a buyer can start a conversation, and the seller sees it in their unified inbox", async () => {
    const seller = await createVerifiedUser(app, { email: "msgseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "msgbuyer@example.com" });
    const listing = await createListing(seller.agent);

    const sendRes = await buyer.agent.post("/api/messages/thread").send({ listingId: listing.id, text: "Is this available?" });
    expect(sendRes.status).toBe(201);
    expect(sendRes.body.conversation.messages).toHaveLength(1);

    const inboxRes = await seller.agent.get("/api/messages/conversations");
    expect(inboxRes.status).toBe(200);
    const convo = inboxRes.body.conversations.find((c) => c.listingId === listing.id);
    expect(convo).toBeDefined();
    expect(convo.role).toBe("seller");
  });

  test("a third, unrelated user cannot read or reply to someone else's conversation", async () => {
    const seller = await createVerifiedUser(app, { email: "msgseller2@example.com" });
    const buyer = await createVerifiedUser(app, { email: "msgbuyer2@example.com" });
    const stranger = await createVerifiedUser(app, { email: "msgstranger@example.com" });
    const listing = await createListing(seller.agent);

    const sendRes = await buyer.agent.post("/api/messages/thread").send({ listingId: listing.id, text: "Hello" });
    const conversationId = sendRes.body.conversation.id;

    const strangerReply = await stranger.agent
      .post(`/api/messages/conversations/${conversationId}/reply`)
      .send({ text: "I shouldn't be able to do this" });
    expect(strangerReply.status).toBe(403);

    const strangerInbox = await stranger.agent.get("/api/messages/conversations");
    const leaked = strangerInbox.body.conversations.find((c) => c.id === conversationId);
    expect(leaked).toBeUndefined();
  });

  test("a seller cannot message their own listing", async () => {
    const seller = await createVerifiedUser(app, { email: "ownlisting@example.com" });
    const listing = await createListing(seller.agent);

    const res = await seller.agent.post("/api/messages/thread").send({ listingId: listing.id, text: "hi myself" });
    expect(res.status).toBe(400);
  });

  test("seller replying sets sellerReplied and the reply appears for the buyer", async () => {
    const seller = await createVerifiedUser(app, { email: "replyseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "replybuyer@example.com" });
    const listing = await createListing(seller.agent);

    const sendRes = await buyer.agent.post("/api/messages/thread").send({ listingId: listing.id, text: "Question?" });
    const conversationId = sendRes.body.conversation.id;

    const replyRes = await seller.agent.post(`/api/messages/conversations/${conversationId}/reply`).send({ text: "Real answer from the seller" });
    expect(replyRes.status).toBe(201);
    expect(replyRes.body.conversation.sellerReplied).toBe(true);

    const buyerThread = await buyer.agent.get(`/api/messages/thread?listingId=${listing.id}`);
    const texts = buyerThread.body.conversation.messages.map((m) => m.text);
    expect(texts).toContain("Real answer from the seller");
  });

  // --- Concurrency: messages are their own table now, so concurrent
  // writes to one conversation are just independent row inserts - nothing
  // to clobber. Verify that holds under real concurrent requests.
  test("concurrent message writes: two rapid replies in the same conversation both land, distinctly and in order", async () => {
    const seller = await createVerifiedUser(app, { email: "concurrentseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "concurrentbuyer@example.com" });
    const listing = await createListing(seller.agent);

    await buyer.agent.post("/api/messages/thread").send({ listingId: listing.id, text: "Starting message" });
    const { rows } = await query("SELECT id FROM conversations WHERE listing_id = $1 AND buyer_id = $2", [listing.id, buyer.user.id]);
    const conversationId = rows[0].id;

    // Let the out-of-band AI reply (triggered by the starting message)
    // land and settle before the seller replies for real - isolates this
    // test to purely the concurrent human-write case that follows,
    // without coupling its message-count assertion to AI-reply timing.
    await waitFor(async () => {
      const { rows } = await query("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = $1 AND sender_type = 'ai'", [conversationId]);
      return Number(rows[0].n) >= 1;
    });
    await seller.agent.post(`/api/messages/conversations/${conversationId}/reply`).send({ text: "seller ack" });

    const beforeCount = (await query("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = $1", [conversationId])).rows[0].n;

    const [r1, r2] = await Promise.all([
      buyer.agent.post(`/api/messages/conversations/${conversationId}/reply`).send({ text: "buyer message A" }),
      buyer.agent.post(`/api/messages/conversations/${conversationId}/reply`).send({ text: "buyer message B" }),
    ]);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);

    const { rows: messages } = await query("SELECT text FROM messages WHERE conversation_id = $1 ORDER BY id ASC", [conversationId]);
    const texts = messages.map((m) => m.text);
    expect(texts).toContain("buyer message A");
    expect(texts).toContain("buyer message B");
    // Both concurrent writes landed as their own distinct rows on top of
    // whatever was there before - nothing lost to a read-modify-write race.
    expect(messages.length).toBe(Number(beforeCount) + 2);
  });

  // --- AI race condition: two buyer messages sent close together should
  // still only trigger one AI-generated reply, not one per message.
  test("AI race condition: two rapid buyer messages trigger at most one AI reply", async () => {
    const seller = await createVerifiedUser(app, { email: "airaceseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "airacebuyer@example.com" });
    const listing = await createListing(seller.agent);

    // First message creates the conversation; fire a second one right
    // behind it before the first's AI reply has necessarily resolved.
    const first = await buyer.agent.post("/api/messages/thread").send({ listingId: listing.id, text: "message one" });
    const conversationId = first.body.conversation.id;
    await buyer.agent.post(`/api/messages/conversations/${conversationId}/reply`).send({ text: "message two, sent immediately after" });

    const gotAiReply = await waitFor(async () => {
      const { rows } = await query("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = $1 AND sender_type = 'ai'", [conversationId]);
      return Number(rows[0].n) >= 1;
    });
    expect(gotAiReply).toBe(true);

    // Give any wrongly-duplicated second AI call a moment it would need to
    // land too, then confirm there's still exactly one.
    await new Promise((r) => setTimeout(r, 300));
    const { rows } = await query("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = $1 AND sender_type = 'ai'", [conversationId]);
    expect(Number(rows[0].n)).toBe(1);
  });
});
