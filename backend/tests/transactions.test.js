const request = require("supertest");
require("../tests/setupEnv");

// Mock only the external Stripe API - every bit of OUR logic (checkout's
// atomic claim, the webhook handler, idempotency, the expiry sweep) runs
// for real against the real test database. This is the right boundary:
// we don't have real Stripe test credentials to hit their actual API from
// this sandbox, but nothing about that should stop us from testing our own
// code paths thoroughly.
const mockPaymentIntentsCreate = jest.fn().mockImplementation(async ({ amount, metadata }) => ({
  id: `pi_test_${Math.random().toString(36).slice(2)}`,
  client_secret: "secret_test",
  amount,
  metadata,
}));
const mockRefundsCreate = jest.fn().mockResolvedValue({ id: "re_test_123" });
const mockConstructEvent = jest.fn().mockImplementation((rawBody) => JSON.parse(rawBody.toString()));

jest.mock("stripe", () => {
  return jest.fn().mockImplementation(() => ({
    paymentIntents: { create: mockPaymentIntentsCreate },
    refunds: { create: mockRefundsCreate },
    webhooks: { constructEvent: mockConstructEvent },
    accounts: { create: jest.fn(), retrieve: jest.fn() },
    accountLinks: { create: jest.fn() },
  }));
});

const app = require("../server");
const { query } = require("../db");
const { resetDb } = require("./dbReset");
const { createVerifiedUser, createListing: createListingBase } = require("./helpers");
const transactionsService = require("../services/transactionsService");

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
});

beforeEach(() => {
  mockPaymentIntentsCreate.mockClear();
  mockRefundsCreate.mockClear();
});

async function createListing(sellerAgent, overrides = {}) {
  return createListingBase(sellerAgent, { category: "toys", title: "Test toy", priceCents: 2000, ...overrides });
}

function sendWebhook(eventType, dataObject) {
  return request(app)
    .post("/api/v1/transactions/webhook")
    .set("Content-Type", "application/json")
    .set("stripe-signature", "irrelevant-because-constructEvent-is-mocked")
    .send(JSON.stringify({ type: eventType, data: { object: dataObject } }));
}

describe("checkout + webhook", () => {
  // (P1 #10) Previously checkout silently collected the full amount into
  // the platform's own account when the seller had no working Connect
  // account - taking a buyer's money for an item there's no automated way
  // to pay the seller for. Refusing up front is the honest behaviour.
  test("checkout is refused when the seller can't receive payouts", async () => {
    const seller = await createVerifiedUser(app, { email: "nopayoutseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "nopayoutbuyer@example.com" });

    // Deliberately NOT calling makeSellerPayoutReady - create the listing
    // directly so the seller stays un-onboarded.
    const listingRes = await seller.agent.post("/api/v1/listings").send({
      category: "toys", title: "Unbuyable toy", priceCents: 1000, condition: "Good", city: "Helsinki", area: "Kamppi",
    });

    const res = await buyer.agent.post("/api/v1/transactions/checkout").send({ listingId: listingRes.body.listing.id });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/payouts/i);

    // Crucially: no PaymentIntent was created, and the listing wasn't
    // left stuck in 'reserved' by a half-completed checkout.
    expect(mockPaymentIntentsCreate).not.toHaveBeenCalled();
    const check = await request(app).get(`/api/v1/listings/${listingRes.body.listing.id}`);
    expect(check.body.listing.status).toBe("active");
  });

  test("checkout is refused when seller charges are enabled but payouts are disabled", async () => {
    const seller = await createVerifiedUser(app, {
      email: "nopayoutsenabled@example.com",
    });
    const buyer = await createVerifiedUser(app, {
      email: "nopayoutbuyer2@example.com",
    });

    const listing = await createListing(seller.agent);

    // Seller has a Connect account and can accept charges, but Stripe
    // has not enabled payouts yet.
    await query(
      "UPDATE users SET connect_payouts_enabled = false WHERE id = $1",
      [seller.user.id]
    );

    const res = await buyer.agent
      .post("/api/v1/transactions/checkout")
      .send({ listingId: listing.id });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/payouts/i);

    // Checkout must fail before Stripe creates a PaymentIntent and before
    // the listing is reserved.
    expect(mockPaymentIntentsCreate).not.toHaveBeenCalled();

    const check = await request(app).get(`/api/v1/listings/${listing.id}`);
    expect(check.body.listing.status).toBe("active");
  });

  test("commission and totals are exact integer cents, not float-rounded", async () => {
    const seller = await createVerifiedUser(app, { email: "centsseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "centsbuyer@example.com" });
    // 19.99 EUR - a price that would have been exactly the kind of value
    // float arithmetic (round2()) risked drifting on. 8% of 1999 cents is
    // 159.92, which should round to exactly 160 cents - not 159, not
    // 160.00000000001, not a string with a stray decimal.
    const listing = await createListing(seller.agent, { priceCents: 1999 });

    const checkoutRes = await buyer.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id, deliveryMethod: "delivery" });
    const t = checkoutRes.body.transaction;

    expect(t.item_amount_cents).toBe(1999);
    expect(t.delivery_fee_cents).toBe(500);
    expect(t.total_amount_cents).toBe(2499); // exact integer addition, not 2499.0000000000002
    expect(t.commission_amount_cents).toBe(160); // Math.round(1999 * 8 / 100) = Math.round(159.92) = 160
    expect(Number.isInteger(t.item_amount_cents)).toBe(true);
    expect(Number.isInteger(t.total_amount_cents)).toBe(true);
    expect(Number.isInteger(t.commission_amount_cents)).toBe(true);
  });

  test("full flow: checkout claims the listing, webhook confirms the sale", async () => {
    const seller = await createVerifiedUser(app, { email: "txseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "txbuyer@example.com" });
    const listing = await createListing(seller.agent);

    const checkoutRes = await buyer.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });
    expect(checkoutRes.status).toBe(201);
    expect(checkoutRes.body.clientSecret).toBeTruthy();

    const midway = await request(app).get(`/api/v1/listings/${listing.id}`);
    expect(midway.body.listing.status).toBe("reserved");

    const paymentIntentId = checkoutRes.body.transaction.stripe_payment_intent_id;
    const webhookRes = await sendWebhook("payment_intent.succeeded", { id: paymentIntentId });
    expect(webhookRes.status).toBe(200);

    const after = await request(app).get(`/api/v1/listings/${listing.id}`);
    expect(after.body.listing.status).toBe("sold");

    const { rows } = await query("SELECT status FROM transactions WHERE stripe_payment_intent_id = $1", [paymentIntentId]);
    expect(rows[0].status).toBe("paid");
  });

  test("webhook idempotency: the same succeeded event delivered twice only processes once", async () => {
    const seller = await createVerifiedUser(app, { email: "idemseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "idembuyer@example.com" });
    const listing = await createListing(seller.agent);

    const checkoutRes = await buyer.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });
    const paymentIntentId = checkoutRes.body.transaction.stripe_payment_intent_id;

    const first = await sendWebhook("payment_intent.succeeded", { id: paymentIntentId });
    const second = await sendWebhook("payment_intent.succeeded", { id: paymentIntentId });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200); // Stripe redelivers events; must not error on a duplicate

    const { rows } = await query("SELECT status FROM transactions WHERE stripe_payment_intent_id = $1", [paymentIntentId]);
    expect(rows[0].status).toBe("paid"); // not double-processed into some other state

    const listingRes = await request(app).get(`/api/v1/listings/${listing.id}`);
    expect(listingRes.body.listing.status).toBe("sold");
  });

  test("payment_failed releases the reservation back to active", async () => {
    const seller = await createVerifiedUser(app, { email: "failseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "failbuyer@example.com" });
    const listing = await createListing(seller.agent);

    const checkoutRes = await buyer.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });
    const paymentIntentId = checkoutRes.body.transaction.stripe_payment_intent_id;

    await sendWebhook("payment_intent.payment_failed", { id: paymentIntentId });

    const listingRes = await request(app).get(`/api/v1/listings/${listing.id}`);
    expect(listingRes.body.listing.status).toBe("active");

    const { rows } = await query("SELECT status FROM transactions WHERE stripe_payment_intent_id = $1", [paymentIntentId]);
    expect(rows[0].status).toBe("cancelled");
  });

  // Edge case: the reservation-expiry sweep (or a failure webhook) already
  // released the listing - maybe to another buyer - and *then* the
  // original payment actually succeeds on Stripe's side. We can't honor a
  // sale for an item that's no longer reserved for this buyer, so the late
  // payment should be auto-refunded rather than silently kept or
  // incorrectly marked as a completed sale.
  test("a late payment_intent.succeeded after the transaction already expired triggers an automatic refund", async () => {
    const seller = await createVerifiedUser(app, { email: "lateseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "latebuyer@example.com" });
    const listing = await createListing(seller.agent);

    const checkoutRes = await buyer.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });
    const paymentIntentId = checkoutRes.body.transaction.stripe_payment_intent_id;
    const transactionId = checkoutRes.body.transaction.id;

    // Simulate the expiry sweep having already fired for this transaction.
    await query("UPDATE transactions SET status = 'expired' WHERE id = $1", [transactionId]);
    await query("UPDATE listings SET status = 'active', reserved_at = NULL WHERE id = $1", [listing.id]);

    await sendWebhook("payment_intent.succeeded", { id: paymentIntentId });

    // Now also asserts the idempotency key. Without one, a retried webhook
    // (delivery is at-least-once) would refund the buyer a second time.
    expect(mockRefundsCreate).toHaveBeenCalledWith(
      { payment_intent: paymentIntentId },
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^late-payment-refund-/) })
    );
    const { rows } = await query("SELECT status FROM transactions WHERE id = $1", [transactionId]);
    expect(rows[0].status).toBe("refunded");

    // The listing must NOT have been flipped back to sold by the late event.
    const listingRes = await request(app).get(`/api/v1/listings/${listing.id}`);
    expect(listingRes.body.listing.status).toBe("active");
  });
});

describe("reservation expiry", () => {
  test("releaseExpiredReservations frees a listing whose reservation is older than the TTL", async () => {
    const seller = await createVerifiedUser(app, { email: "expireseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "expirebuyer@example.com" });
    const listing = await createListing(seller.agent);

    const checkoutRes = await buyer.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });
    const transactionId = checkoutRes.body.transaction.id;

    // Backdate the reservation well past the TTL, as if the buyer
    // abandoned checkout a long time ago with no resolving webhook.
    await query("UPDATE listings SET reserved_at = now() - interval '1 hour' WHERE id = $1", [listing.id]);

    const released = await transactionsService.releaseExpiredReservations();
    expect(released).toBeGreaterThanOrEqual(1);

    const listingRes = await request(app).get(`/api/v1/listings/${listing.id}`);
    expect(listingRes.body.listing.status).toBe("active");

    const { rows } = await query("SELECT status FROM transactions WHERE id = $1", [transactionId]);
    expect(rows[0].status).toBe("expired");
  });

  test("a fresh reservation (within the TTL) is left alone", async () => {
    const seller = await createVerifiedUser(app, { email: "freshseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "freshbuyer@example.com" });
    const listing = await createListing(seller.agent);

    await buyer.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });
    // reserved_at defaults to "now" - well within the TTL, nothing to sweep.

    await transactionsService.releaseExpiredReservations();

    const listingRes = await request(app).get(`/api/v1/listings/${listing.id}`);
    expect(listingRes.body.listing.status).toBe("reserved");
  });
});

// The "Pickup / Delivery -> Review" step of the user journey. 'completed'
// was already accepted as review-eligible, but nothing ever set it -
// transactions stayed 'paid' forever, so this step existed only on paper.
describe("order completion (confirm receipt)", () => {
  async function paidOrder(sellerEmail, buyerEmail) {
    const seller = await createVerifiedUser(app, { email: sellerEmail });
    const buyer = await createVerifiedUser(app, { email: buyerEmail });
    const listing = await createListing(seller.agent);
    const checkout = await buyer.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });
    await sendWebhook("payment_intent.succeeded", { id: checkout.body.transaction.stripe_payment_intent_id });
    return { seller, buyer, listing, transactionId: checkout.body.transaction.id };
  }

  test("a buyer can confirm receipt, moving the order from paid to completed", async () => {
    const { buyer, transactionId } = await paidOrder("confirmseller@example.com", "confirmbuyer@example.com");

    const res = await buyer.agent.post(`/api/v1/transactions/${transactionId}/confirm-receipt`);
    expect(res.status).toBe(200);
    expect(res.body.transaction.status).toBe("completed");
  });

  // The person who received the item is the only one who can attest that
  // they did - a seller marking their own sale complete would make the
  // signal meaningless.
  test("a seller cannot confirm receipt of their own sale", async () => {
    const { seller, transactionId } = await paidOrder("noconfirmseller@example.com", "noconfirmbuyer@example.com");

    const res = await seller.agent.post(`/api/v1/transactions/${transactionId}/confirm-receipt`);
    expect(res.status).toBe(403);
  });

  test("an unrelated user cannot confirm someone else's order", async () => {
    const { transactionId } = await paidOrder("thirdseller@example.com", "thirdbuyer@example.com");
    const stranger = await createVerifiedUser(app, { email: "thirdstranger@example.com" });

    const res = await stranger.agent.post(`/api/v1/transactions/${transactionId}/confirm-receipt`);
    expect(res.status).toBe(403);
  });

  // Transitions are now idempotent when the order is ALREADY in the target
  // state. That's required for the webhook path (Stripe re-delivers events
  // routinely, and a redelivery must not be an error), and it's better
  // behaviour for a double-clicked button too. The guarantee that matters
  // is that it doesn't happen *twice*: no second audit event, no double
  // notification, no counter moved twice.
  test("confirming twice is a no-op, not a second completion", async () => {
    const { buyer, transactionId } = await paidOrder("twiceseller@example.com", "twicebuyer@example.com");

    const first = await buyer.agent.post(`/api/v1/transactions/${transactionId}/confirm-receipt`);
    const second = await buyer.agent.post(`/api/v1/transactions/${transactionId}/confirm-receipt`);

    expect(first.body.transaction.status).toBe("completed");
    expect(second.body.transaction.status).toBe("completed");

    // Exactly one completion event, however many times it was called.
    const { rows } = await query(
      "SELECT COUNT(*) AS n FROM transaction_events WHERE transaction_id = $1 AND to_status = 'completed'",
      [transactionId]
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  test("an unpaid order can't be confirmed", async () => {
    const seller = await createVerifiedUser(app, { email: "unpaidseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "unpaidbuyer@example.com" });
    const listing = await createListing(seller.agent);
    // Checkout only - no payment webhook, so this stays 'pending'.
    const checkout = await buyer.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });

    const res = await buyer.agent.post(`/api/v1/transactions/${checkout.body.transaction.id}/confirm-receipt`);
    expect(res.status).toBe(409);
  });

  test("confirming receipt still leaves the order review-eligible", async () => {
    const { seller, buyer, listing, transactionId } = await paidOrder("revflowseller@example.com", "revflowbuyer@example.com");
    await buyer.agent.post(`/api/v1/transactions/${transactionId}/confirm-receipt`);

    // 'completed' is one of the review-eligible statuses - the whole point
    // of the step existing.
    const review = await buyer.agent.post("/api/v1/reviews").send({
      revieweeId: seller.user.id, listingId: listing.id, rating: 5, comment: "Smooth handover",
    });
    expect(review.status).toBe(201);
  });
});
