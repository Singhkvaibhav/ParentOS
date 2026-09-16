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
const mockRefundsCreate = jest.fn().mockResolvedValue({ id: "re_test" });
const mockPaymentIntentsCancel = jest.fn().mockResolvedValue({ id: "pi_cancelled" });
jest.mock("stripe", () => jest.fn().mockImplementation(() => ({
  paymentIntents: { create: mockPaymentIntentsCreate, cancel: mockPaymentIntentsCancel },
  refunds: { create: mockRefundsCreate },
  webhooks: { constructEvent: jest.fn().mockImplementation((raw) => JSON.parse(raw.toString())) },
  accounts: { create: jest.fn(), retrieve: jest.fn() },
  accountLinks: { create: jest.fn() },
})));

const app = require("../server");
const { query } = require("../db");
const { resetDb } = require("./dbReset");
const { createVerifiedUser, createListing: createListingBase } = require("./helpers");

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
});

beforeEach(() => {
  mockRefundsCreate.mockClear();
  mockPaymentIntentsCancel.mockClear();
});

async function createListing(sellerAgent, overrides = {}) {
  return createListingBase(sellerAgent, { category: "toys", title: "Lifecycle toy", priceCents: 1500, ...overrides });
}

function sendWebhook(type, object) {
  return request(app).post("/api/v1/transactions/webhook")
    .set("Content-Type", "application/json").set("stripe-signature", "mocked")
    .send(JSON.stringify({ type, data: { object } }));
}

async function paidOrder(sellerEmail, buyerEmail) {
  const seller = await createVerifiedUser(app, { email: sellerEmail });
  const buyer = await createVerifiedUser(app, { email: buyerEmail });
  const listing = await createListing(seller.agent);
  const checkout = await buyer.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });
  await sendWebhook("payment_intent.succeeded", { id: checkout.body.transaction.stripe_payment_intent_id });
  return { seller, buyer, listing, transactionId: checkout.body.transaction.id };
}

// P0 #2: pending -> paid -> fulfilled -> completed, with cancelled /
// refunded / disputed as exceptional exits.
describe("transaction lifecycle", () => {
  test("the happy path runs paid -> fulfilled -> completed", async () => {
    const { seller, buyer, transactionId } = await paidOrder("lcseller@example.com", "lcbuyer@example.com");

    const fulfilled = await seller.agent.post(`/api/v1/transactions/${transactionId}/fulfil`);
    expect(fulfilled.status).toBe(200);
    expect(fulfilled.body.transaction.status).toBe("fulfilled");
    expect(fulfilled.body.transaction.fulfilled_at).not.toBeNull();

    const completed = await buyer.agent.post(`/api/v1/transactions/${transactionId}/confirm-receipt`);
    expect(completed.status).toBe(200);
    expect(completed.body.transaction.status).toBe("completed");
    expect(completed.body.transaction.completed_at).not.toBeNull();
  });

  test("a buyer can confirm receipt directly from paid, without a fulfil step", async () => {
    // Pickup in person - there's no "posted it" moment to record.
    const { buyer, transactionId } = await paidOrder("directseller@example.com", "directbuyer@example.com");
    const res = await buyer.agent.post(`/api/v1/transactions/${transactionId}/confirm-receipt`);
    expect(res.status).toBe(200);
    expect(res.body.transaction.status).toBe("completed");
  });

  test("only the seller can mark an order fulfilled", async () => {
    const { buyer, transactionId } = await paidOrder("fulseller@example.com", "fulbuyer@example.com");
    const res = await buyer.agent.post(`/api/v1/transactions/${transactionId}/fulfil`);
    expect(res.status).toBe(403);
  });

  test("only the buyer can confirm receipt", async () => {
    const { seller, transactionId } = await paidOrder("confseller@example.com", "confbuyer@example.com");
    const res = await seller.agent.post(`/api/v1/transactions/${transactionId}/confirm-receipt`);
    expect(res.status).toBe(403);
  });

  test("invalid transitions are refused", async () => {
    const { seller, buyer, transactionId } = await paidOrder("invseller@example.com", "invbuyer@example.com");
    await buyer.agent.post(`/api/v1/transactions/${transactionId}/confirm-receipt`); // -> completed

    // completed can't go back to fulfilled
    const res = await seller.agent.post(`/api/v1/transactions/${transactionId}/fulfil`);
    expect(res.status).toBe(409);
  });

  test("an unpaid order can't be fulfilled or confirmed", async () => {
    const seller = await createVerifiedUser(app, { email: "unpaidlcseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "unpaidlcbuyer@example.com" });
    const listing = await createListing(seller.agent);
    const checkout = await buyer.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });
    const id = checkout.body.transaction.id;

    expect((await seller.agent.post(`/api/v1/transactions/${id}/fulfil`)).status).toBe(409);
    expect((await buyer.agent.post(`/api/v1/transactions/${id}/confirm-receipt`)).status).toBe(409);
  });

  // Either party can be wronged - a buyer falsely claiming non-delivery
  // harms the seller just as much as the reverse.
  test("either party can raise a dispute", async () => {
    const a = await paidOrder("dispseller1@example.com", "dispbuyer1@example.com");
    const byBuyer = await a.buyer.agent.post(`/api/v1/transactions/${a.transactionId}/dispute`).send({ reason: "Never arrived" });
    expect(byBuyer.status).toBe(200);
    expect(byBuyer.body.transaction.status).toBe("disputed");

    const b = await paidOrder("dispseller2@example.com", "dispbuyer2@example.com");
    const bySeller = await b.seller.agent.post(`/api/v1/transactions/${b.transactionId}/dispute`).send({ reason: "Buyer claims non-delivery falsely" });
    expect(bySeller.status).toBe(200);
    expect(bySeller.body.transaction.status).toBe("disputed");
  });

  test("a dispute requires a reason", async () => {
    const { buyer, transactionId } = await paidOrder("noreasonseller@example.com", "noreasonbuyer@example.com");
    const res = await buyer.agent.post(`/api/v1/transactions/${transactionId}/dispute`).send({});
    expect(res.status).toBe(400);
  });

  test("an unrelated user can't touch someone else's order", async () => {
    const { transactionId } = await paidOrder("privseller@example.com", "privbuyer@example.com");
    const stranger = await createVerifiedUser(app, { email: "lcstranger@example.com" });
    expect((await stranger.agent.post(`/api/v1/transactions/${transactionId}/fulfil`)).status).toBe(403);
    expect((await stranger.agent.post(`/api/v1/transactions/${transactionId}/dispute`).send({ reason: "x" })).status).toBe(403);
  });
});

// P0 #1: a takedown means the item shouldn't be sold - money already in
// flight has to be dealt with, not silently left.
describe("moderation vs in-flight payments", () => {
  async function makeAdmin() {
    const admin = await createVerifiedUser(app, { email: `modadmin${Math.random().toString(36).slice(2)}@example.com` });
    await query("UPDATE users SET is_admin = true WHERE id = $1", [admin.user.id]);
    return admin;
  }

  test("taking down a listing with a PAID order refunds the buyer", async () => {
    const admin = await makeAdmin();
    const { listing, transactionId } = await paidOrder("modpaidseller@example.com", "modpaidbuyer@example.com");

    const res = await admin.agent.post(`/api/v1/moderation/listings/${listing.id}/takedown`).send({ reason: "Recalled product" });
    expect(res.status).toBe(200);

    expect(mockRefundsCreate).toHaveBeenCalled();
    const { rows } = await query("SELECT status, cancellation_reason FROM transactions WHERE id = $1", [transactionId]);
    expect(rows[0].status).toBe("refunded");
    expect(rows[0].cancellation_reason).toContain("moderator");
  });

  test("taking down a listing with a PENDING order cancels the payment intent", async () => {
    const admin = await makeAdmin();
    const seller = await createVerifiedUser(app, { email: "modpendseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "modpendbuyer@example.com" });
    const listing = await createListing(seller.agent);
    const checkout = await buyer.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });

    await admin.agent.post(`/api/v1/moderation/listings/${listing.id}/takedown`).send({ reason: "Prohibited" });

    // Cancelling stops the PaymentIntent ever capturing - a refund would
    // be the wrong tool here, since no money moved yet.
    expect(mockPaymentIntentsCancel).toHaveBeenCalled();
    expect(mockRefundsCreate).not.toHaveBeenCalled();
    const { rows } = await query("SELECT status FROM transactions WHERE id = $1", [checkout.body.transaction.id]);
    expect(rows[0].status).toBe("cancelled");
  });

  // A finished deal shouldn't be unwound automatically - the buyer has the
  // item and confirmed it. That's a dispute, not an automatic refund.
  test("a COMPLETED order is left alone by a takedown", async () => {
    const admin = await makeAdmin();
    const { buyer, listing, transactionId } = await paidOrder("modcompseller@example.com", "modcompbuyer@example.com");
    await buyer.agent.post(`/api/v1/transactions/${transactionId}/confirm-receipt`);

    await admin.agent.post(`/api/v1/moderation/listings/${listing.id}/takedown`).send({ reason: "Late report" });

    expect(mockRefundsCreate).not.toHaveBeenCalled();
    const { rows } = await query("SELECT status FROM transactions WHERE id = $1", [transactionId]);
    expect(rows[0].status).toBe("completed");
  });

  test("the buyer is notified their order was cancelled and refunded", async () => {
    const admin = await makeAdmin();
    const { buyer, listing } = await paidOrder("modnotifyseller@example.com", "modnotifybuyer@example.com");
    await admin.agent.post(`/api/v1/moderation/listings/${listing.id}/takedown`).send({ reason: "Unsafe" });

    // notify() is deliberately fire-and-forget (a refund must not fail
    // because a notification couldn't be written), so this has to wait for
    // it rather than assume it landed synchronously.
    let found = 0;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && found === 0) {
      const { rows } = await query(
        "SELECT * FROM notifications WHERE user_id = $1 AND type = 'order_cancelled'",
        [buyer.user.id]
      );
      found = rows.length;
      if (found === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(found).toBeGreaterThanOrEqual(1);
  });
});

// P1 #5: a moderated listing was excluded from browse but still
// retrievable by anyone holding its id.
describe("moderated listings are not publicly retrievable", () => {
  async function takenDownListing() {
    const admin = await createVerifiedUser(app, { email: `hideadmin${Math.random().toString(36).slice(2)}@example.com` });
    await query("UPDATE users SET is_admin = true WHERE id = $1", [admin.user.id]);
    const seller = await createVerifiedUser(app, { email: `hideseller${Math.random().toString(36).slice(2)}@example.com` });
    const listing = await createListing(seller.agent, { title: "Hidden item" });
    await admin.agent.post(`/api/v1/moderation/listings/${listing.id}/takedown`).send({ reason: "Unsafe" });
    return { admin, seller, listing };
  }

  test("an anonymous visitor with the direct id gets a 404", async () => {
    const { listing } = await takenDownListing();
    const res = await request(app).get(`/api/v1/listings/${listing.id}`);
    expect(res.status).toBe(404);
  });

  test("another logged-in user also gets a 404", async () => {
    const { listing } = await takenDownListing();
    const other = await createVerifiedUser(app, { email: `hideother${Math.random().toString(36).slice(2)}@example.com` });
    const res = await other.agent.get(`/api/v1/listings/${listing.id}`);
    expect(res.status).toBe(404);
  });

  test("the seller can still see it, so they know what was removed", async () => {
    const { seller, listing } = await takenDownListing();
    const res = await seller.agent.get(`/api/v1/listings/${listing.id}`);
    expect(res.status).toBe(200);
    expect(res.body.listing.moderation_reason).toBeTruthy();
  });

  test("a moderator can still see it for review", async () => {
    const { admin, listing } = await takenDownListing();
    const res = await admin.agent.get(`/api/v1/listings/${listing.id}`);
    expect(res.status).toBe(200);
  });
});

// P1 #3 (message length) - the rate limits themselves are skipped in tests
// by design, but the length cap is pure validation and always applies.
describe("message length limit", () => {
  test("an over-long message is rejected", async () => {
    const seller = await createVerifiedUser(app, { email: "lenseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "lenbuyer@example.com" });
    const listing = await createListing(seller.agent);

    const res = await buyer.agent.post("/api/v1/messages/thread").send({
      listingId: listing.id, text: "A".repeat(5000),
    });
    expect(res.status).toBe(400);
  });

  test("a normal-length message is still fine", async () => {
    const seller = await createVerifiedUser(app, { email: "lenokseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "lenokbuyer@example.com" });
    const listing = await createListing(seller.agent);

    const res = await buyer.agent.post("/api/v1/messages/thread").send({
      listingId: listing.id, text: "Is this still available?",
    });
    expect(res.status).toBe(201);
  });
});

// A disputed order was previously a dead end: the transition table allowed
// disputed -> refunded/completed but nothing implemented either, so every
// dispute was permanent and the money frozen with it.
describe("dispute resolution", () => {
  async function makeAdmin() {
    const admin = await createVerifiedUser(app, { email: `dr${Math.random().toString(36).slice(2)}@example.com` });
    await query("UPDATE users SET is_admin = true WHERE id = $1", [admin.user.id]);
    return admin;
  }

  async function disputedOrder(sellerEmail, buyerEmail) {
    const o = await paidOrder(sellerEmail, buyerEmail);
    await o.buyer.agent.post(`/api/v1/transactions/${o.transactionId}/dispute`).send({ reason: "Never arrived" });
    return o;
  }

  test("an admin can refund the buyer, closing the dispute", async () => {
    const admin = await makeAdmin();
    const { transactionId } = await disputedOrder("drs1@example.com", "drb1@example.com");

    const res = await admin.agent.post(`/api/v1/transactions/${transactionId}/resolve-dispute`)
      .send({ outcome: "refund", note: "Seller could not show proof of handover." });
    expect(res.status).toBe(200);
    expect(res.body.transaction.status).toBe("refunded");
    expect(mockRefundsCreate).toHaveBeenCalled();
  });

  test("an admin can uphold the sale, and the seller regains credit for it", async () => {
    const admin = await makeAdmin();
    const { seller, transactionId } = await disputedOrder("drs2@example.com", "drb2@example.com");

    // Disputing removed it from the seller's completed count.
    const during = await query("SELECT completed_sales_count FROM users WHERE id = $1", [seller.user.id]);
    expect(during.rows[0].completed_sales_count).toBe(0);

    const res = await admin.agent.post(`/api/v1/transactions/${transactionId}/resolve-dispute`)
      .send({ outcome: "uphold", note: "Tracking shows delivery." });
    expect(res.status).toBe(200);
    expect(res.body.transaction.status).toBe("completed");

    // Counters are derived from 'completed', so upholding restores it
    // automatically rather than needing a compensating write.
    const after = await query("SELECT completed_sales_count FROM users WHERE id = $1", [seller.user.id]);
    expect(after.rows[0].completed_sales_count).toBe(1);
  });

  test("neither party can resolve their own dispute", async () => {
    const { buyer, seller, transactionId } = await disputedOrder("drs3@example.com", "drb3@example.com");
    const body = { outcome: "refund", note: "please" };
    expect((await buyer.agent.post(`/api/v1/transactions/${transactionId}/resolve-dispute`).send(body)).status).toBe(403);
    expect((await seller.agent.post(`/api/v1/transactions/${transactionId}/resolve-dispute`).send(body)).status).toBe(403);
  });

  test("a resolution note is required, since disputes get re-examined later", async () => {
    const admin = await makeAdmin();
    const { transactionId } = await disputedOrder("drs4@example.com", "drb4@example.com");
    const res = await admin.agent.post(`/api/v1/transactions/${transactionId}/resolve-dispute`)
      .send({ outcome: "refund" });
    expect(res.status).toBe(400);
  });

  test("an order that isn't disputed can't be 'resolved'", async () => {
    const admin = await makeAdmin();
    const { transactionId } = await paidOrder("drs5@example.com", "drb5@example.com");
    const res = await admin.agent.post(`/api/v1/transactions/${transactionId}/resolve-dispute`)
      .send({ outcome: "refund", note: "n/a" });
    expect(res.status).toBe(409);
  });

  test("the resolution is attributed in the audit trail", async () => {
    const admin = await makeAdmin();
    const { buyer, transactionId } = await disputedOrder("drs6@example.com", "drb6@example.com");
    await admin.agent.post(`/api/v1/transactions/${transactionId}/resolve-dispute`)
      .send({ outcome: "refund", note: "Refunded after review." });

    const res = await buyer.agent.get(`/api/v1/transactions/${transactionId}/history`);
    const event = res.body.events.find((e) => e.to_status === "refunded");
    expect(event.actor_type).toBe("admin");
    expect(event.reason).toContain("Refunded after review");
  });
});

// The whole journey in one test, over HTTP, against a real database.
//
// The individual transitions are covered above, but nothing asserted that
// they compose - and the gaps this project keeps finding have all been
// between correct pieces (a status nothing set, an endpoint nothing
// called). This walks the entire chain and checks its side effects.
describe("full journey: checkout -> paid -> fulfilled -> completed -> review", () => {
  test("every step composes, and the trust and audit side effects follow", async () => {
    const seller = await createVerifiedUser(app, { email: "journeyseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "journeybuyer@example.com" });
    const listing = await createListing(seller.agent, { title: "Journey stroller", priceCents: 2500 });

    // 1. Checkout reserves the item and creates a pending order.
    const checkout = await buyer.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });
    expect(checkout.status).toBe(201);
    const id = checkout.body.transaction.id;
    expect(checkout.body.transaction.status).toBe("pending");

    // 2. Stripe confirms payment.
    await sendWebhook("payment_intent.succeeded", { id: checkout.body.transaction.stripe_payment_intent_id });
    const afterPay = await query("SELECT status, paid_at FROM transactions WHERE id = $1", [id]);
    expect(afterPay.rows[0].status).toBe("paid");
    expect(afterPay.rows[0].paid_at).not.toBeNull();

    // The listing must leave the marketplace once it's sold.
    const browse = await request(app).get("/api/v1/listings?q=Journey%20stroller");
    expect(browse.body.listings.some((l) => l.id === listing.id)).toBe(false);

    // Payment alone must NOT credit the seller with a completed sale.
    const midTrust = await request(app).get(`/api/v1/users/${seller.user.id}`);
    expect(midTrust.body.user.trust.completedSales).toBe(0);

    // 3. Seller hands it over.
    expect((await seller.agent.post(`/api/v1/transactions/${id}/fulfil`)).status).toBe(200);

    // 4. Buyer confirms receipt - the only step that completes an order.
    expect((await buyer.agent.post(`/api/v1/transactions/${id}/confirm-receipt`)).status).toBe(200);

    // 5. Review is now permitted (and was not, before completion).
    const review = await buyer.agent.post("/api/v1/reviews").send({
      revieweeId: seller.user.id, listingId: listing.id, rating: 5, comment: "Exactly as described.",
    });
    expect(review.status).toBe(201);

    // 6. Trust reflects a genuinely concluded sale.
    const finalTrust = await request(app).get(`/api/v1/users/${seller.user.id}`);
    expect(finalTrust.body.user.trust.completedSales).toBe(1);

    // 7. The audit trail tells the whole story, in order.
    const history = await buyer.agent.get(`/api/v1/transactions/${id}/history`);
    const statuses = history.body.events.map((e) => e.to_status);
    expect(statuses).toEqual(expect.arrayContaining(["paid", "fulfilled", "completed"]));
    expect(statuses.indexOf("paid")).toBeLessThan(statuses.indexOf("fulfilled"));
    expect(statuses.indexOf("fulfilled")).toBeLessThan(statuses.indexOf("completed"));
  });
});

// Checkout writes the transaction row and its first audit event. These
// were previously two independent statements, so a failure between them
// left either an order whose history begins mid-lifecycle, or an orphaned
// 'pending' row whose PaymentIntent the error handler had already
// cancelled.
describe("checkout is atomic", () => {
  test("a new order always has a creation event, from the very first read", async () => {
    const seller = await createVerifiedUser(app, { email: "atomicseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "atomicbuyer@example.com" });
    const listing = await createListing(seller.agent);

    const checkout = await buyer.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });
    expect(checkout.status).toBe(201);

    const { rows } = await query(
      "SELECT event_type, to_status FROM transaction_events WHERE transaction_id = $1 ORDER BY id",
      [checkout.body.transaction.id]
    );
    expect(rows[0].event_type).toBe("order_created");
    expect(rows[0].to_status).toBe("pending");
  });

  test("no transaction row exists without a corresponding creation event", async () => {
    // The invariant the atomicity buys. Checked across every order the
    // suite has created, so a future non-atomic path would trip it.
    const { rows } = await query(`
      SELECT t.id FROM transactions t
      WHERE NOT EXISTS (
        SELECT 1 FROM transaction_events e
        WHERE e.transaction_id = t.id AND e.event_type = 'order_created'
      )
    `);
    expect(rows).toHaveLength(0);
  });
});

// Stripe telling the browser "succeeded" and this backend recording the
// order as paid are two different facts, separated by webhook delivery.
// The client previously inferred the second from the first, so a delayed
// or failed webhook meant the UI claimed an order confirmation the server
// had never made.
describe("order status endpoint", () => {
  test("reports unsettled before the webhook arrives", async () => {
    const seller = await createVerifiedUser(app, { email: "statusseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "statusbuyer@example.com" });
    const listing = await createListing(seller.agent);

    const checkout = await buyer.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });

    const res = await buyer.agent.get(`/api/v1/transactions/${checkout.body.transaction.id}/status`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
    // The flag the client actually polls on.
    expect(res.body.settled).toBe(false);
    expect(res.body.paidAt).toBeNull();
  });

  test("reports settled once the webhook has been processed", async () => {
    const seller = await createVerifiedUser(app, { email: "statusseller2@example.com" });
    const buyer = await createVerifiedUser(app, { email: "statusbuyer2@example.com" });
    const listing = await createListing(seller.agent);

    const checkout = await buyer.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });
    await sendWebhook("payment_intent.succeeded", { id: checkout.body.transaction.stripe_payment_intent_id });

    const res = await buyer.agent.get(`/api/v1/transactions/${checkout.body.transaction.id}/status`);
    expect(res.body.status).toBe("paid");
    expect(res.body.settled).toBe(true);
    expect(res.body.paidAt).not.toBeNull();
  });

  test("the seller can also read it", async () => {
    const seller = await createVerifiedUser(app, { email: "statusseller3@example.com" });
    const buyer = await createVerifiedUser(app, { email: "statusbuyer3@example.com" });
    const listing = await createListing(seller.agent);
    const checkout = await buyer.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });

    expect((await seller.agent.get(`/api/v1/transactions/${checkout.body.transaction.id}/status`)).status).toBe(200);
  });

  // It's polled, so it must not become a way to enumerate other people's
  // orders by walking ids.
  test("an unrelated user cannot read it", async () => {
    const seller = await createVerifiedUser(app, { email: "statusseller4@example.com" });
    const buyer = await createVerifiedUser(app, { email: "statusbuyer4@example.com" });
    const stranger = await createVerifiedUser(app, { email: "statusstranger@example.com" });
    const listing = await createListing(seller.agent);
    const checkout = await buyer.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });

    expect((await stranger.agent.get(`/api/v1/transactions/${checkout.body.transaction.id}/status`)).status).toBe(403);
  });

  test("requires authentication", async () => {
    expect((await request(app).get("/api/v1/transactions/1/status")).status).toBe(401);
  });

  // A refunded or cancelled order is settled too - the client is asking
  // "has the server finished deciding?", not "did it succeed?".
  test("a resolved-but-not-paid order also reports settled", async () => {
    const seller = await createVerifiedUser(app, { email: "statusseller5@example.com" });
    const buyer = await createVerifiedUser(app, { email: "statusbuyer5@example.com" });
    const listing = await createListing(seller.agent);
    const checkout = await buyer.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });

    await query("UPDATE transactions SET status = 'cancelled' WHERE id = $1", [checkout.body.transaction.id]);

    const res = await buyer.agent.get(`/api/v1/transactions/${checkout.body.transaction.id}/status`);
    expect(res.body.settled).toBe(true);
    expect(res.body.status).toBe("cancelled");
  });
});
