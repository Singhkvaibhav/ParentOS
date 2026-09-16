const request = require("supertest");
require("../tests/setupEnv");

jest.mock("../ai/controller", () => ({
  AiUnavailableError: class extends Error {},
  getAutoReply: jest.fn().mockResolvedValue("Mocked auto-reply."),
}));

const mockPaymentIntentsCreate = jest.fn().mockImplementation(async ({ amount, metadata }) => ({
  id: `pi_test_${Math.random().toString(36).slice(2)}`,
  client_secret: "secret_test", amount, metadata,
}));
jest.mock("stripe", () => jest.fn().mockImplementation(() => ({
  paymentIntents: { create: mockPaymentIntentsCreate, cancel: jest.fn() },
  refunds: { create: jest.fn() },
  webhooks: { constructEvent: jest.fn().mockImplementation((raw) => JSON.parse(raw.toString())) },
  accounts: { create: jest.fn(), retrieve: jest.fn() },
  accountLinks: { create: jest.fn() },
})));

const app = require("../server");
const { query } = require("../db");
const { resetDb } = require("./dbReset");
const { createVerifiedUser, makeSellerPayoutReady } = require("./helpers");

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
});

async function createListing(sellerAgent, overrides = {}) {
  const res = await sellerAgent.post("/api/listings").send({
    category: "toys", title: "Notify test toy", priceCents: 1000, condition: "Good", city: "Helsinki", area: "Kamppi", ...overrides,
  });
  await makeSellerPayoutReady(res.body.listing.seller_id);
  return res.body.listing;
}

// Notifications are created fire-and-forget so a marketplace action never
// fails because delivery didn't work - which means tests have to wait for
// them rather than assuming they've landed synchronously.
async function waitForNotification(userId, type, { timeout = 3000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const { rows } = await query(
      "SELECT * FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY id DESC LIMIT 1",
      [userId, type]
    );
    if (rows[0]) return rows[0];
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

describe("notification triggers", () => {
  test("a seller is notified when a buyer messages about their listing", async () => {
    const seller = await createVerifiedUser(app, { email: "notifyseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "notifybuyer@example.com" });
    const listing = await createListing(seller.agent, { title: "Notifiable stroller" });

    await buyer.agent.post("/api/messages/thread").send({ listingId: listing.id, text: "Is this available?" });

    const n = await waitForNotification(seller.user.id, "message_received");
    expect(n).not.toBeNull();
    expect(n.title).toContain("Notifiable stroller");
    expect(n.listing_id).toBe(listing.id);
  });

  test("the buyer is notified when the seller replies", async () => {
    const seller = await createVerifiedUser(app, { email: "replynotifyseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "replynotifybuyer@example.com" });
    const listing = await createListing(seller.agent);

    const send = await buyer.agent.post("/api/messages/thread").send({ listingId: listing.id, text: "hello" });
    await seller.agent.post(`/api/messages/conversations/${send.body.conversation.id}/reply`).send({ text: "yes it is" });

    const n = await waitForNotification(buyer.user.id, "message_received");
    expect(n).not.toBeNull();
  });

  test("both parties are notified when a sale completes, and the sale is captured for product analytics", async () => {
    const productAnalytics = require("../services/productAnalyticsService");
    const captureSpy = jest.spyOn(productAnalytics, "capture");

    const seller = await createVerifiedUser(app, { email: "salenotifyseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "salenotifybuyer@example.com" });
    const listing = await createListing(seller.agent);

    const checkout = await buyer.agent.post("/api/transactions/checkout").send({ listingId: listing.id });
    await request(app)
      .post("/api/transactions/webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "mocked")
      .send(JSON.stringify({
        type: "payment_intent.succeeded",
        data: { object: { id: checkout.body.transaction.stripe_payment_intent_id } },
      }));

    expect(await waitForNotification(seller.user.id, "item_sold")).not.toBeNull();
    expect(await waitForNotification(buyer.user.id, "purchase_confirmed")).not.toBeNull();

    // The webhook, not the buyer's browser, is the source of truth for
    // this funnel event - see productAnalyticsService.js.
    expect(captureSpy).toHaveBeenCalledWith(buyer.user.id, "purchase_completed", expect.objectContaining({
      listingId: listing.id,
    }));
    captureSpy.mockRestore();
  });

  test("a seller is told when their listing is taken down, and why", async () => {
    const admin = await createVerifiedUser(app, { email: "notifyadmin@example.com" });
    await query("UPDATE users SET is_admin = true WHERE id = $1", [admin.user.id]);
    const seller = await createVerifiedUser(app, { email: "takedownnotify@example.com" });
    const listing = await createListing(seller.agent);

    await admin.agent.post(`/api/moderation/listings/${listing.id}/takedown`).send({ reason: "Recalled product" });

    const n = await waitForNotification(seller.user.id, "listing_taken_down");
    expect(n).not.toBeNull();
    expect(n.body).toContain("Recalled");
  });
});

describe("notification API", () => {
  test("requires authentication", async () => {
    const res = await request(app).get("/api/notifications");
    expect(res.status).toBe(401);
  });

  test("lists notifications with an unread count", async () => {
    const seller = await createVerifiedUser(app, { email: "listnotify@example.com" });
    const buyer = await createVerifiedUser(app, { email: "listnotifybuyer@example.com" });
    const listing = await createListing(seller.agent);
    await buyer.agent.post("/api/messages/thread").send({ listingId: listing.id, text: "hi" });
    await waitForNotification(seller.user.id, "message_received");

    const res = await seller.agent.get("/api/notifications");
    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBeGreaterThanOrEqual(1);
    expect(res.body.notifications.length).toBeGreaterThanOrEqual(1);
  });

  test("marking one read decrements the unread count", async () => {
    const seller = await createVerifiedUser(app, { email: "markread@example.com" });
    const buyer = await createVerifiedUser(app, { email: "markreadbuyer@example.com" });
    const listing = await createListing(seller.agent);
    await buyer.agent.post("/api/messages/thread").send({ listingId: listing.id, text: "hi" });
    const n = await waitForNotification(seller.user.id, "message_received");

    const before = (await seller.agent.get("/api/notifications")).body.unreadCount;
    await seller.agent.post(`/api/notifications/${n.id}/read`);
    const after = (await seller.agent.get("/api/notifications")).body.unreadCount;

    expect(after).toBe(before - 1);
  });

  // Scoping is enforced in the WHERE clause, so guessing an id belonging
  // to someone else can't mark their notification read.
  test("you can't mark someone else's notification as read", async () => {
    const seller = await createVerifiedUser(app, { email: "scopeseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "scopebuyer@example.com" });
    const stranger = await createVerifiedUser(app, { email: "scopestranger@example.com" });
    const listing = await createListing(seller.agent);
    await buyer.agent.post("/api/messages/thread").send({ listingId: listing.id, text: "hi" });
    const n = await waitForNotification(seller.user.id, "message_received");

    const res = await stranger.agent.post(`/api/notifications/${n.id}/read`);
    expect(res.status).toBe(404);

    const { rows } = await query("SELECT read_at FROM notifications WHERE id = $1", [n.id]);
    expect(rows[0].read_at).toBeNull(); // untouched
  });

  test("read-all clears the unread count", async () => {
    const seller = await createVerifiedUser(app, { email: "readall@example.com" });
    const buyer = await createVerifiedUser(app, { email: "readallbuyer@example.com" });
    const listing = await createListing(seller.agent);
    await buyer.agent.post("/api/messages/thread").send({ listingId: listing.id, text: "hi" });
    await waitForNotification(seller.user.id, "message_received");

    await seller.agent.post("/api/notifications/read-all");
    const res = await seller.agent.get("/api/notifications");
    expect(res.body.unreadCount).toBe(0);
  });

  test("a user who turns email notifications off still gets in-app ones", async () => {
    const seller = await createVerifiedUser(app, { email: "noemail@example.com" });
    const buyer = await createVerifiedUser(app, { email: "noemailbuyer@example.com" });
    const listing = await createListing(seller.agent);

    await seller.agent.post("/api/notifications/email-preference").send({ enabled: false });
    await buyer.agent.post("/api/messages/thread").send({ listingId: listing.id, text: "hi" });

    const n = await waitForNotification(seller.user.id, "message_received");
    expect(n).not.toBeNull(); // stored regardless
    expect(n.emailed_at).toBeNull(); // but not emailed
  });
});
