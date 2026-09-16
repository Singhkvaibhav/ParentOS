const request = require("supertest");
require("../tests/setupEnv");

// Same approach as transactions.test.js: mock only the external Stripe API
// so a real checkout -> webhook flow can run against the real test
// database, giving us a real 'paid' transaction to review against instead
// of faking one directly in the database.
const mockPaymentIntentsCreate = jest.fn().mockImplementation(async ({ amount, metadata }) => ({
  id: `pi_test_${Math.random().toString(36).slice(2)}`,
  client_secret: "secret_test",
  amount,
  metadata,
}));
const mockConstructEvent = jest.fn().mockImplementation((rawBody) => JSON.parse(rawBody.toString()));

jest.mock("stripe", () => {
  return jest.fn().mockImplementation(() => ({
    paymentIntents: { create: mockPaymentIntentsCreate },
    refunds: { create: jest.fn() },
    webhooks: { constructEvent: mockConstructEvent },
    accounts: { create: jest.fn(), retrieve: jest.fn() },
    accountLinks: { create: jest.fn() },
  }));
});

const app = require("../server");
const { resetDb } = require("./dbReset");
const { createVerifiedUser, createListing: createListingBase } = require("./helpers");

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
});

async function createListing(sellerAgent, overrides = {}) {
  return createListingBase(sellerAgent, { category: "clothes", title: "Reviewable item", priceCents: 1200, ...overrides });
}

async function completeAPurchase(buyerAgent, listingId) {
  const checkoutRes = await buyerAgent.post("/api/v1/transactions/checkout").send({ listingId });
  const paymentIntentId = checkoutRes.body.transaction.stripe_payment_intent_id;
  await request(app)
    .post("/api/v1/transactions/webhook")
    .set("Content-Type", "application/json")
    .set("stripe-signature", "irrelevant-because-constructEvent-is-mocked")
    .send(JSON.stringify({ type: "payment_intent.succeeded", data: { object: { id: paymentIntentId } } }));

  // Reviews require the order to have genuinely COMPLETED - payment
  // succeeding isn't enough, or a seller could collect stars without ever
  // handing anything over.
  await buyerAgent.post(`/api/v1/transactions/${checkoutRes.body.transaction.id}/confirm-receipt`);
  return checkoutRes.body.transaction.id;
}

describe("reviews", () => {
  test("rejected while the order is only paid - the buyer hasn't confirmed receipt", async () => {
    const seller = await createVerifiedUser(app, { email: "revpaidonlyseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "revpaidonlybuyer@example.com" });
    const listing = await createListing(seller.agent);

    // Pay, but stop short of confirming receipt.
    const checkoutRes = await buyer.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });
    await request(app)
      .post("/api/v1/transactions/webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "irrelevant-because-constructEvent-is-mocked")
      .send(JSON.stringify({
        type: "payment_intent.succeeded",
        data: { object: { id: checkoutRes.body.transaction.stripe_payment_intent_id } },
      }));

    const res = await buyer.agent.post("/api/v1/reviews").send({
      revieweeId: seller.user.id, listingId: listing.id, rating: 5, comment: "too early",
    });
    expect(res.status).toBe(403);
  });

  test("rejected without a real transaction between reviewer and reviewee for that listing", async () => {
    const seller = await createVerifiedUser(app, { email: "revnotxseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "revnotxbuyer@example.com" });
    const listing = await createListing(seller.agent);

    const res = await buyer.agent.post("/api/v1/reviews").send({ revieweeId: seller.user.id, listingId: listing.id, rating: 5, comment: "never bought this" });
    expect(res.status).toBe(403);
  });

  test("rejects an out-of-range rating even with a real transaction", async () => {
    const seller = await createVerifiedUser(app, { email: "revrangeseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "revrangebuyer@example.com" });
    const listing = await createListing(seller.agent);
    await completeAPurchase(buyer.agent, listing.id);

    const res = await buyer.agent.post("/api/v1/reviews").send({ revieweeId: seller.user.id, listingId: listing.id, rating: 7, comment: "too high" });
    expect(res.status).toBe(400);
  });

  test("succeeds after a real completed transaction, and shows up on the seller's public profile", async () => {
    const seller = await createVerifiedUser(app, { email: "revokseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "revokbuyer@example.com" });
    const listing = await createListing(seller.agent);
    await completeAPurchase(buyer.agent, listing.id);

    const reviewRes = await buyer.agent.post("/api/v1/reviews").send({ revieweeId: seller.user.id, listingId: listing.id, rating: 5, comment: "Great seller, item as described!" });
    expect(reviewRes.status).toBe(201);

    const profileRes = await request(app).get(`/api/v1/users/${seller.user.id}`);
    expect(profileRes.body.user.reviewCount).toBeGreaterThanOrEqual(1);
    // averageRating is deliberately withheld below MIN_RATING_COUNT_TO_DISPLAY
    // (see trustService): "5.0 from 1 review" reads as far stronger
    // evidence than it actually is. The count is still shown.
    expect(profileRes.body.user.averageRating).toBeNull();
    expect(profileRes.body.user.trust.hasEnoughReviewsToRate).toBe(false);

    const listRes = await request(app).get(`/api/v1/reviews/user/${seller.user.id}`);
    expect(listRes.body.reviews.some((r) => r.comment === "Great seller, item as described!")).toBe(true);
  });

  test("the same buyer can't review the same seller twice for the same listing", async () => {
    const seller = await createVerifiedUser(app, { email: "revdupseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "revdupbuyer@example.com" });
    const listing = await createListing(seller.agent);
    await completeAPurchase(buyer.agent, listing.id);

    await buyer.agent.post("/api/v1/reviews").send({ revieweeId: seller.user.id, listingId: listing.id, rating: 4, comment: "first review" });
    const secondRes = await buyer.agent.post("/api/v1/reviews").send({ revieweeId: seller.user.id, listingId: listing.id, rating: 2, comment: "trying again" });
    expect(secondRes.status).toBe(409);
  });

  test("can't review yourself", async () => {
    const seller = await createVerifiedUser(app, { email: "revselfseller@example.com" });
    const listing = await createListing(seller.agent);
    const res = await seller.agent.post("/api/v1/reviews").send({ revieweeId: seller.user.id, listingId: listing.id, rating: 5, comment: "self review" });
    expect(res.status).toBe(400);
  });
});
