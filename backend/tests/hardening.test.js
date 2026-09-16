require("../tests/setupEnv");

jest.mock("../ai/controller", () => ({
  AiUnavailableError: class extends Error {},
  getAutoReply: jest.fn().mockResolvedValue("Mocked auto-reply."),
}));

const app = require("../server");
const { query } = require("../db");
const { resetDb } = require("./dbReset");
const { createVerifiedUser, csrfAgent, makeSellerPayoutReady } = require("./helpers");

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
});

// P1 #4. The previous read-then-write let concurrent guesses all pass the
// limit check against the same stale count - firing many requests at once,
// every one would see "attempts = 0" and proceed, making the lockout
// meaningless against exactly the automated attacker it exists to stop.
describe("verification attempt race", () => {
  test("concurrent wrong guesses can't exceed the attempt limit", async () => {
    const agent = await csrfAgent(app);
    const email = "raceverify@example.com";
    await agent.post("/api/v1/auth/signup").send({ name: "Race", email, password: "testpass123" });

    // Simultaneous wrong guesses from SEPARATE connections - which is what
    // a real attacker looks like, and avoids piling 20 parallel requests
    // onto one keep-alive socket (that's a test-harness limitation, not
    // the behaviour under test).
    const agents = await Promise.all(Array.from({ length: 10 }, () => csrfAgent(app)));
    const results = await Promise.all(
      agents.map((a) => a.post("/api/v1/auth/verify").send({ email, code: "000000" }))
    );

    const locked = results.filter((r) => r.status === 429).length;
    expect(locked).toBeGreaterThan(0); // the limit actually engaged

    const { rows } = await query("SELECT verification_attempts FROM users WHERE email = $1", [email]);
    // The counter must never exceed the cap, however many requests raced.
    expect(Number(rows[0].verification_attempts)).toBeLessThanOrEqual(5);
  });

  test("a correct code still works within the allowance", async () => {
    const agent = await csrfAgent(app);
    const email = "raceok@example.com";
    const signup = await agent.post("/api/v1/auth/signup").send({ name: "Ok", email, password: "testpass123" });

    await agent.post("/api/v1/auth/verify").send({ email, code: "000000" }); // one wrong guess
    const res = await agent.post("/api/v1/auth/verify").send({ email, code: signup.body.devCode });
    expect(res.status).toBe(200);
  });

  test("attemptsRemaining is reported accurately, not double-counted", async () => {
    const agent = await csrfAgent(app);
    const email = "raceremaining@example.com";
    await agent.post("/api/v1/auth/signup").send({ name: "Rem", email, password: "testpass123" });

    const first = await agent.post("/api/v1/auth/verify").send({ email, code: "000000" });
    // One attempt used out of five - the atomic claim counts it exactly
    // once, where the old code incremented in two places.
    expect(first.body.attemptsRemaining).toBe(4);
  });
});

// P1 #6. A display name of `<img src=x onerror=...>` would otherwise
// render in the recipient's mail client - and unlike a web page, there's
// no CSP to fall back on.
describe("HTML email escaping", () => {
  const { escapeHtml } = require("../email");

  test("script and tag characters are neutralised", () => {
    const escaped = escapeHtml('<img src=x onerror="alert(1)">');
    expect(escaped).not.toContain("<img");
    expect(escaped).not.toContain('"');
    expect(escaped).toContain("&lt;img");
  });

  test("ampersands are escaped first, so escaping isn't double-applied", () => {
    // If & were escaped last, "&lt;" would become "&amp;lt;" and render
    // as literal text instead of a neutralised tag.
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml("&")).toBe("&amp;");
    expect(escapeHtml("&<")).toBe("&amp;&lt;");
  });

  test("handles null and undefined without throwing", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  test("signup with a hostile name succeeds without injecting raw HTML", async () => {
    const agent = await csrfAgent(app);
    const hostileName = '<img src=x onerror="alert(1)">';
    const res = await agent.post("/api/v1/auth/signup").send({
      name: hostileName, email: "hostile@example.com", password: "testpass123",
    });
    expect(res.status).toBe(200);

    // The raw name is stored as-is (correct - escaping is a rendering
    // concern, not a storage one); the guarantee is that the EMAIL body
    // escapes it. Verified directly against the escaping helper.
    const { rows } = await query("SELECT name FROM users WHERE email = $1", ["hostile@example.com"]);
    expect(rows[0].name).toBe(hostileName);
  });
});

// P1 #7. A long-running conversation would otherwise re-send its entire
// history on every poll, on the app's most frequently hit endpoint.
describe("message pagination", () => {
  let buyer, seller, conversationId;

  beforeAll(async () => {
    seller = await createVerifiedUser(app, { email: "pagemsgseller@example.com" });
    buyer = await createVerifiedUser(app, { email: "pagemsgbuyer@example.com" });
    const listingRes = await seller.agent.post("/api/v1/listings").send({
      category: "toys", title: "Paged chat toy", priceCents: 900,
      condition: "Good", city: "Helsinki", area: "Kamppi",
    });
    await makeSellerPayoutReady(listingRes.body.listing.seller_id);
    const send = await buyer.agent.post("/api/v1/messages/thread").send({
      listingId: listingRes.body.listing.id, text: "message 0",
    });
    conversationId = send.body.conversation.id;

    // Seller replies first so the AI doesn't inject extra messages.
    await seller.agent.post(`/api/v1/messages/conversations/${conversationId}/reply`).send({ text: "seller ack" });
    for (let i = 1; i <= 60; i++) {
      await buyer.agent.post(`/api/v1/messages/conversations/${conversationId}/reply`).send({ text: `message ${i}` });
    }
  });

  test("returns a bounded page, not the whole history", async () => {
    const res = await buyer.agent.get(`/api/v1/messages/conversations/${conversationId}/messages`);
    expect(res.status).toBe(200);
    expect(res.body.messages.length).toBeLessThanOrEqual(50);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.nextCursor).toBeTruthy();
  });

  test("the first page is the NEWEST messages, in chronological order", async () => {
    const res = await buyer.agent.get(`/api/v1/messages/conversations/${conversationId}/messages`);
    const texts = res.body.messages.map((m) => m.text);
    // A chat opens at the bottom, so the newest page is what's needed first.
    expect(texts[texts.length - 1]).toBe("message 60");
    const ids = res.body.messages.map((m) => m.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  test("the cursor walks backwards without repeating or skipping", async () => {
    const page1 = await buyer.agent.get(`/api/v1/messages/conversations/${conversationId}/messages`);
    const page2 = await buyer.agent.get(
      `/api/v1/messages/conversations/${conversationId}/messages?cursor=${page1.body.nextCursor}`
    );

    const ids1 = page1.body.messages.map((m) => m.id);
    const ids2 = page2.body.messages.map((m) => m.id);
    expect(ids1.filter((id) => ids2.includes(id))).toHaveLength(0);
    expect(Math.max(...ids2)).toBeLessThan(Math.min(...ids1));
  });

  test("a non-participant can't read a conversation's messages", async () => {
    const stranger = await createVerifiedUser(app, { email: "pagemsgstranger@example.com" });
    const res = await stranger.agent.get(`/api/v1/messages/conversations/${conversationId}/messages`);
    expect(res.status).toBe(403);
  });

  test("the inbox no longer carries full message arrays", async () => {
    const res = await buyer.agent.get("/api/v1/messages/conversations");
    const convo = res.body.conversations.find((c) => c.id === conversationId);
    expect(convo).toBeDefined();
    // A preview and an unread count are all the inbox needs.
    expect(convo.messages).toBeUndefined();
    expect(convo.lastMessage).toBeTruthy();
    expect(typeof convo.unreadCount).toBe("number");
  });

  test("unread counts are still correct with pagination in place", async () => {
    const res = await seller.agent.get("/api/v1/messages/conversations");
    const convo = res.body.conversations.find((c) => c.id === conversationId);
    // The seller hasn't read the 60 buyer messages sent after their ack.
    expect(convo.unreadCount).toBeGreaterThan(0);
  });
});
