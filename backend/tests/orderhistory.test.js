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
  refunds: { create: jest.fn().mockResolvedValue({ id: "re_test" }) },
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
    category: "toys", title: "History toy", priceCents: 1500, condition: "Good", city: "Helsinki", area: "Kamppi", ...overrides,
  });
  await makeSellerPayoutReady(res.body.listing.seller_id);
  return res.body.listing;
}

function sendWebhook(type, object) {
  return request(app).post("/api/transactions/webhook")
    .set("Content-Type", "application/json").set("stripe-signature", "mocked")
    .send(JSON.stringify({ type, data: { object } }));
}

async function paidOrder(sellerEmail, buyerEmail) {
  const seller = await createVerifiedUser(app, { email: sellerEmail });
  const buyer = await createVerifiedUser(app, { email: buyerEmail });
  const listing = await createListing(seller.agent);
  const checkout = await buyer.agent.post("/api/transactions/checkout").send({ listingId: listing.id });
  await sendWebhook("payment_intent.succeeded", { id: checkout.body.transaction.stripe_payment_intent_id });
  return { seller, buyer, listing, transactionId: checkout.body.transaction.id };
}

// The audit trail is the evidence in a dispute, so it has to be complete
// and honest about who did what.
describe("order audit trail", () => {
  test("an order's history starts at creation, not mid-lifecycle", async () => {
    const { buyer, transactionId } = await paidOrder("histseller@example.com", "histbuyer@example.com");
    const res = await buyer.agent.get(`/api/transactions/${transactionId}/history`);

    expect(res.status).toBe(200);
    expect(res.body.events[0].event_type).toBe("order_created");
    expect(res.body.events[0].to_status).toBe("pending");
  });

  test("the full happy path is recorded in order with actors", async () => {
    const { seller, buyer, transactionId } = await paidOrder("fullhistseller@example.com", "fullhistbuyer@example.com");
    await seller.agent.post(`/api/transactions/${transactionId}/fulfil`);
    await buyer.agent.post(`/api/transactions/${transactionId}/confirm-receipt`);

    const res = await buyer.agent.get(`/api/transactions/${transactionId}/history`);
    const trail = res.body.events.map((e) => `${e.from_status ?? "-"}->${e.to_status}:${e.actor_type}`);

    expect(trail).toEqual([
      "-->pending:buyer",
      "pending->paid:system",     // Stripe, not a person
      "paid->fulfilled:seller",
      "fulfilled->completed:buyer",
    ]);
  });

  // "Nobody did this, a timer did" is a real answer in a dispute.
  test("system-driven changes are attributed to the system, not a user", async () => {
    const { buyer, transactionId } = await paidOrder("sysseller@example.com", "sysbuyer@example.com");
    const res = await buyer.agent.get(`/api/transactions/${transactionId}/history`);

    const paidEvent = res.body.events.find((e) => e.to_status === "paid");
    expect(paidEvent.actor_type).toBe("system");
    expect(paidEvent.actor_id).toBeNull();
    expect(paidEvent.metadata.paymentIntentId).toBeTruthy();
  });

  test("a dispute records the reason given", async () => {
    const { buyer, transactionId } = await paidOrder("dispHistSeller@example.com", "disphistbuyer@example.com");
    await buyer.agent.post(`/api/transactions/${transactionId}/dispute`).send({ reason: "Item never arrived" });

    const res = await buyer.agent.get(`/api/transactions/${transactionId}/history`);
    const disputeEvent = res.body.events.find((e) => e.to_status === "disputed");
    expect(disputeEvent.reason).toBe("Item never arrived");
    expect(disputeEvent.actor_type).toBe("buyer");
  });

  test("a moderator takedown is attributed to an admin, with the reason", async () => {
    const admin = await createVerifiedUser(app, { email: "histadmin@example.com" });
    await query("UPDATE users SET is_admin = true WHERE id = $1", [admin.user.id]);
    const { buyer, listing, transactionId } = await paidOrder("modhistseller@example.com", "modhistbuyer@example.com");

    await admin.agent.post(`/api/moderation/listings/${listing.id}/takedown`).send({ reason: "Recalled product" });

    const res = await buyer.agent.get(`/api/transactions/${transactionId}/history`);
    const refund = res.body.events.find((e) => e.to_status === "refunded");
    expect(refund.actor_type).toBe("admin");
    expect(refund.reason).toContain("Recalled product");
  });

  test("history is visible to both parties but not to strangers", async () => {
    const { seller, buyer, transactionId } = await paidOrder("visseller@example.com", "visbuyer@example.com");
    const stranger = await createVerifiedUser(app, { email: "visstranger@example.com" });

    expect((await buyer.agent.get(`/api/transactions/${transactionId}/history`)).status).toBe(200);
    expect((await seller.agent.get(`/api/transactions/${transactionId}/history`)).status).toBe(200);
    expect((await stranger.agent.get(`/api/transactions/${transactionId}/history`)).status).toBe(403);
  });

  // The audit event and the status change are one database transaction, so
  // a status can never move without leaving a trace.
  test("every status the order reached has a matching event", async () => {
    const { seller, buyer, transactionId } = await paidOrder("matchseller@example.com", "matchbuyer@example.com");
    await seller.agent.post(`/api/transactions/${transactionId}/fulfil`);
    await buyer.agent.post(`/api/transactions/${transactionId}/confirm-receipt`);

    const { rows } = await query("SELECT status FROM transactions WHERE id = $1", [transactionId]);
    const events = (await buyer.agent.get(`/api/transactions/${transactionId}/history`)).body.events;
    expect(events[events.length - 1].to_status).toBe(rows[0].status);
  });

  // An invalid transition is a client mistake, not a server fault. If it
  // escapes to the global error handler it gets logged as `unhandled_error`
  // with a stack trace, and production error tracking fills with non-errors.
  test("an invalid transition returns a clean 409, not a server error", async () => {
    const { seller, buyer, transactionId } = await paidOrder("cleanerrseller@example.com", "cleanerrbuyer@example.com");
    await buyer.agent.post(`/api/transactions/${transactionId}/confirm-receipt`);

    const res = await seller.agent.post(`/api/transactions/${transactionId}/fulfil`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/can't become/);
    expect(res.status).toBeLessThan(500);
  });

  // A late payment after expiry has to be refundable - the transition
  // table used to declare 'expired' terminal, which the raw UPDATE hid.
  test("an expired order can still transition to refunded", async () => {
    const { VALID_TRANSITIONS, STATUS } = require("../transactionStatus");
    expect(VALID_TRANSITIONS[STATUS.EXPIRED]).toContain(STATUS.REFUNDED);
    expect(VALID_TRANSITIONS[STATUS.CANCELLED]).toContain(STATUS.REFUNDED);
  });
});
