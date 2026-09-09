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
const { summarize, MIN_RATING_COUNT_TO_DISPLAY } = require("../services/trustService");

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
});

async function createListing(sellerAgent, overrides = {}) {
  const res = await sellerAgent.post("/api/listings").send({
    category: "toys", title: "Trust test toy", priceCents: 1000, condition: "Good", city: "Helsinki", area: "Kamppi", ...overrides,
  });
  await makeSellerPayoutReady(res.body.listing.seller_id);
  return res.body.listing;
}

// Pays for a listing. This settles the money but deliberately stops at
// 'paid' - the deal is NOT concluded until the buyer confirms receipt.
async function payForListing(buyerAgent, listingId) {
  const checkout = await buyerAgent.post("/api/transactions/checkout").send({ listingId });
  await request(app)
    .post("/api/transactions/webhook")
    .set("Content-Type", "application/json")
    .set("stripe-signature", "mocked")
    .send(JSON.stringify({
      type: "payment_intent.succeeded",
      data: { object: { id: checkout.body.transaction.stripe_payment_intent_id } },
    }));
  return checkout.body.transaction.id;
}

// Pays AND has the buyer confirm receipt - the full path to 'completed'.
async function completeSale(buyerAgent, listingId) {
  const transactionId = await payForListing(buyerAgent, listingId);
  await buyerAgent.post(`/api/transactions/${transactionId}/confirm-receipt`);
  return transactionId;
}

// summarize() is pure, so the scoring rules can be tested directly without
// constructing database state for every permutation.
describe("trust summary rules", () => {
  const base = { verified: true, created_at: new Date().toISOString(), rating_sum: 0, rating_count: 0, completed_sales_count: 0 };

  test("an unverified account is always 'unverified', however much it has traded", () => {
    const t = summarize({ ...base, verified: false, completed_sales_count: 50, rating_sum: 250, rating_count: 50 });
    expect(t.level).toBe("unverified");
  });

  test("a brand new verified account is 'new'", () => {
    expect(summarize(base).level).toBe("new");
  });

  test("one completed sale makes an account 'active'", () => {
    expect(summarize({ ...base, completed_sales_count: 1 }).level).toBe("active");
  });

  test("'established' needs sustained volume AND a high average, not just one", () => {
    // Lots of sales but no reviews - not established.
    expect(summarize({ ...base, completed_sales_count: 50 }).level).not.toBe("established");
    // Great reviews but almost no sales - also not established.
    expect(summarize({ ...base, completed_sales_count: 1, rating_sum: 25, rating_count: 5 }).level).not.toBe("established");
    // Both - established.
    expect(summarize({ ...base, completed_sales_count: 12, rating_sum: 24, rating_count: 5 }).level).toBe("established");
  });

  test("an average rating is withheld until there are enough reviews to mean something", () => {
    const tooFew = summarize({ ...base, rating_sum: 5, rating_count: 1 });
    expect(tooFew.averageRating).toBeNull();
    expect(tooFew.ratingCount).toBe(1); // the count is still honest
    expect(tooFew.hasEnoughReviewsToRate).toBe(false);

    const enough = summarize({ ...base, rating_sum: 5 * MIN_RATING_COUNT_TO_DISPLAY, rating_count: MIN_RATING_COUNT_TO_DISPLAY });
    expect(enough.averageRating).toBe(5);
    expect(enough.hasEnoughReviewsToRate).toBe(true);
  });
});

describe("trust counters update from real activity", () => {
  // The counters feed the public trust badge, so they must reflect deals
  // that actually concluded - not payments that merely succeeded.
  test("paying alone does NOT count as a completed sale", async () => {
    const seller = await createVerifiedUser(app, { email: "paidonlyseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "paidonlybuyer@example.com" });
    const listing = await createListing(seller.agent);

    await payForListing(buyer.agent, listing.id); // stops at 'paid'

    const { rows } = await query(
      "SELECT completed_sales_count FROM users WHERE id = $1", [seller.user.id]
    );
    expect(rows[0].completed_sales_count).toBe(0);
  });

  // A seller who takes payment and ships nothing must not accrue trust.
  test("a seller who is paid but never hands over stays at the 'new' level", async () => {
    const seller = await createVerifiedUser(app, { email: "ghostseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "ghostbuyer@example.com" });
    const listing = await createListing(seller.agent);
    await payForListing(buyer.agent, listing.id);

    const res = await request(app).get(`/api/users/${seller.user.id}`);
    expect(res.body.user.trust.completedSales).toBe(0);
    expect(res.body.user.trust.level).toBe("new");
  });

  // Counters are recomputed from source, so a contested sale drops back
  // out rather than being permanently banked.
  test("disputing a completed order removes it from the seller's count", async () => {
    const seller = await createVerifiedUser(app, { email: "disputedcountseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "disputedcountbuyer@example.com" });
    const listing = await createListing(seller.agent);
    const transactionId = await completeSale(buyer.agent, listing.id);

    const before = await query("SELECT completed_sales_count FROM users WHERE id = $1", [seller.user.id]);
    expect(before.rows[0].completed_sales_count).toBe(1);

    await buyer.agent.post(`/api/transactions/${transactionId}/dispute`).send({ reason: "Item never arrived" });

    const after = await query("SELECT completed_sales_count FROM users WHERE id = $1", [seller.user.id]);
    expect(after.rows[0].completed_sales_count).toBe(0);
  });

  test("a confirmed sale increments both parties' counters", async () => {
    const seller = await createVerifiedUser(app, { email: "trustseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "trustbuyer@example.com" });
    const listing = await createListing(seller.agent);

    await completeSale(buyer.agent, listing.id);

    const { rows } = await query(
      "SELECT id, completed_sales_count, completed_purchases_count FROM users WHERE id = ANY($1::int[])",
      [[seller.user.id, buyer.user.id]]
    );
    const s = rows.find((r) => r.id === seller.user.id);
    const b = rows.find((r) => r.id === buyer.user.id);
    expect(s.completed_sales_count).toBe(1);
    expect(b.completed_purchases_count).toBe(1);
  });

  test("a review refreshes the reviewee's cached aggregates", async () => {
    const seller = await createVerifiedUser(app, { email: "aggseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "aggbuyer@example.com" });
    const listing = await createListing(seller.agent);
    await completeSale(buyer.agent, listing.id);

    await buyer.agent.post("/api/reviews").send({
      revieweeId: seller.user.id, listingId: listing.id, rating: 4, comment: "Good",
    });

    const { rows } = await query("SELECT rating_sum, rating_count FROM users WHERE id = $1", [seller.user.id]);
    expect(rows[0].rating_sum).toBe(4);
    expect(rows[0].rating_count).toBe(1);
  });
});

describe("trust is visible where buyers decide", () => {
  test("a listing carries its seller's trust summary, without an extra query per listing", async () => {
    const seller = await createVerifiedUser(app, { email: "cardseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "cardbuyer@example.com" });
    const first = await createListing(seller.agent, { title: "Trust card item one" });
    await completeSale(buyer.agent, first.id);
    await createListing(seller.agent, { title: "Trust card item two" });

    const res = await request(app).get("/api/listings?q=Trust%20card");
    const listing = res.body.listings.find((l) => l.title === "Trust card item two");
    expect(listing.sellerTrust).toBeDefined();
    expect(listing.sellerTrust.completedSales).toBe(1);
    expect(listing.sellerTrust.level).toBe("active");
  });

  test("raw aggregate columns aren't leaked into the API response", async () => {
    const seller = await createVerifiedUser(app, { email: "leakseller@example.com" });
    await createListing(seller.agent, { title: "Leak check item" });

    const res = await request(app).get("/api/listings?q=Leak%20check");
    const listing = res.body.listings[0];
    expect(listing.seller_rating_sum).toBeUndefined();
    expect(listing.seller_rating_count).toBeUndefined();
    expect(listing.seller_completed_sales).toBeUndefined();
  });

  test("the public profile exposes the trust summary", async () => {
    const seller = await createVerifiedUser(app, { email: "profiletrust@example.com" });
    const res = await request(app).get(`/api/users/${seller.user.id}`);
    expect(res.body.user.trust).toBeDefined();
    expect(res.body.user.trust.level).toBe("new");
    expect(res.body.user.trust.completedSales).toBe(0);
  });

  test("the profile still never exposes email", async () => {
    const seller = await createVerifiedUser(app, { email: "stillnoemail@example.com" });
    const res = await request(app).get(`/api/users/${seller.user.id}`);
    expect(res.body.user.email).toBeUndefined();
  });
});
