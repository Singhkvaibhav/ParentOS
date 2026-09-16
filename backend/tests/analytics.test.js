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
const { createVerifiedUser, createListing: createListingBase } = require("./helpers");

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
});

async function createListing(sellerAgent, overrides = {}) {
  return createListingBase(sellerAgent, { category: "toys", title: "Analytics toy", priceCents: 2000, ...overrides });
}

// Pays only - the order reaches 'paid' and stops there.
async function payForListing(buyerAgent, listingId) {
  const checkout = await buyerAgent.post("/api/v1/transactions/checkout").send({ listingId });
  await request(app)
    .post("/api/v1/transactions/webhook")
    .set("Content-Type", "application/json")
    .set("stripe-signature", "mocked")
    .send(JSON.stringify({
      type: "payment_intent.succeeded",
      data: { object: { id: checkout.body.transaction.stripe_payment_intent_id } },
    }));
  return checkout.body.transaction.id;
}

// Pays AND confirms receipt - the full path to 'completed'.
async function completeSale(buyerAgent, listingId) {
  const transactionId = await payForListing(buyerAgent, listingId);
  await buyerAgent.post(`/api/v1/transactions/${transactionId}/confirm-receipt`);
  return transactionId;
}

// View recording happens after the response is sent, so tests must wait
// for it rather than assume it landed synchronously.
async function waitForViewCount(listingId, atLeast, { timeout = 3000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const { rows } = await query("SELECT view_count FROM listings WHERE id = $1", [listingId]);
    if (Number(rows[0]?.view_count ?? 0) >= atLeast) return Number(rows[0].view_count);
    await new Promise((r) => setTimeout(r, 40));
  }
  const { rows } = await query("SELECT view_count FROM listings WHERE id = $1", [listingId]);
  return Number(rows[0]?.view_count ?? 0);
}

describe("listing views", () => {
  test("viewing a listing records a view", async () => {
    const seller = await createVerifiedUser(app, { email: "viewseller@example.com" });
    const listing = await createListing(seller.agent);

    await request(app).get(`/api/v1/listings/${listing.id}`);
    expect(await waitForViewCount(listing.id, 1)).toBeGreaterThanOrEqual(1);
  });

  test("anonymous views are counted - browsing doesn't require an account", async () => {
    const seller = await createVerifiedUser(app, { email: "anonviewseller@example.com" });
    const listing = await createListing(seller.agent);

    await request(app).get(`/api/v1/listings/${listing.id}`); // no session cookie
    await waitForViewCount(listing.id, 1);

    const { rows } = await query(
      "SELECT viewer_id FROM listing_views WHERE listing_id = $1 ORDER BY id DESC LIMIT 1",
      [listing.id]
    );
    expect(rows[0].viewer_id).toBeNull(); // recorded, attributed to nobody
  });

  // A seller refreshing their own listing would otherwise inflate the
  // exact number they're trying to read.
  test("a seller's own views are not counted", async () => {
    const seller = await createVerifiedUser(app, { email: "selfviewseller@example.com" });
    const listing = await createListing(seller.agent);

    await seller.agent.get(`/api/v1/listings/${listing.id}`);
    await new Promise((r) => setTimeout(r, 400)); // give the async write a chance to land

    const { rows } = await query("SELECT view_count FROM listings WHERE id = $1", [listing.id]);
    expect(Number(rows[0].view_count)).toBe(0);
  });
});

describe("seller analytics", () => {
  test("requires authentication", async () => {
    expect((await request(app).get("/api/v1/analytics/me")).status).toBe(401);
  });

  test("reports views, conversations, sales and net earnings", async () => {
    const seller = await createVerifiedUser(app, { email: "statsseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "statsbuyer@example.com" });
    const listing = await createListing(seller.agent, { priceCents: 2000 });

    await request(app).get(`/api/v1/listings/${listing.id}`);
    await waitForViewCount(listing.id, 1);
    await buyer.agent.post("/api/v1/messages/thread").send({ listingId: listing.id, text: "interested" });
    await completeSale(buyer.agent, listing.id);

    const res = await seller.agent.get("/api/v1/analytics/me");
    expect(res.status).toBe(200);
    expect(res.body.stats.totalViews).toBeGreaterThanOrEqual(1);
    expect(res.body.stats.conversations).toBeGreaterThanOrEqual(1);
    expect(res.body.stats.completedSales).toBe(1);
    // 2000 cents at 8% commission = 160, so the seller nets 1840.
    expect(res.body.stats.netEarnedCents).toBe(1840);
  });

  // "0% conversion" reads as failure when the truth is "no data yet".
  test("conversion rate is null rather than 0 when there are no views", async () => {
    const seller = await createVerifiedUser(app, { email: "noviewsseller@example.com" });
    const res = await seller.agent.get("/api/v1/analytics/me");
    expect(res.body.stats.viewToSaleRate).toBeNull();
  });

  // A paid-but-unhandled-over order is real captured revenue, but it is
  // NOT a concluded sale - reporting them as one figure is the mistake
  // that made the trust counters wrong.
  test("money captured is reported separately from deals concluded", async () => {
    const seller = await createVerifiedUser(app, { email: "splitstatsseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "splitstatsbuyer@example.com" });
    const listing = await createListing(seller.agent, { priceCents: 2000 });

    await payForListing(buyer.agent, listing.id); // paid, not confirmed

    const res = await seller.agent.get("/api/v1/analytics/me");
    expect(res.body.stats.completedSales).toBe(0);
    expect(res.body.stats.awaitingHandover).toBe(1);
    // The money is genuinely captured, so it still shows as earned.
    expect(res.body.stats.netEarnedCents).toBe(1840);
  });

  test("a seller sees per-listing performance", async () => {
    const seller = await createVerifiedUser(app, { email: "perlistingseller@example.com" });
    const listing = await createListing(seller.agent);
    await request(app).get(`/api/v1/listings/${listing.id}`);
    await waitForViewCount(listing.id, 1);

    const res = await seller.agent.get(`/api/v1/analytics/listings/${listing.id}`);
    expect(res.status).toBe(200);
    expect(res.body.stats.totalViews).toBeGreaterThanOrEqual(1);
    expect(res.body.stats.viewsLast7Days).toBeGreaterThanOrEqual(1);
  });

  // Otherwise anyone could measure a competitor's demand.
  test("per-listing stats are not visible to other users", async () => {
    const seller = await createVerifiedUser(app, { email: "privateseller@example.com" });
    const nosy = await createVerifiedUser(app, { email: "nosyuser@example.com" });
    const listing = await createListing(seller.agent);

    const res = await nosy.agent.get(`/api/v1/analytics/listings/${listing.id}`);
    expect(res.status).toBe(403);
  });
});

describe("platform analytics", () => {
  test("a non-admin can't see platform stats", async () => {
    const user = await createVerifiedUser(app, { email: "notadminstats@example.com" });
    expect((await user.agent.get("/api/v1/analytics/platform")).status).toBe(403);
  });

  test("an admin sees marketplace health metrics", async () => {
    const admin = await createVerifiedUser(app, { email: "statsadmin@example.com" });
    await query("UPDATE users SET is_admin = true WHERE id = $1", [admin.user.id]);
    const seller = await createVerifiedUser(app, { email: "platformseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "platformbuyer@example.com" });
    const listing = await createListing(seller.agent, { priceCents: 2000 });
    await completeSale(buyer.agent, listing.id);

    const res = await admin.agent.get("/api/v1/analytics/platform");
    expect(res.status).toBe(200);
    const s = res.body.stats;

    expect(s.users.total).toBeGreaterThanOrEqual(3);
    expect(s.transactions.completed).toBeGreaterThanOrEqual(1);
    expect(s.transactions).toHaveProperty("inProgress");
    expect(s.transactions).toHaveProperty("disputed");
    expect(s.transactions.commissionCents).toBeGreaterThanOrEqual(160);
    expect(s.listings.sold).toBeGreaterThanOrEqual(1);
    // The core marketplace question: does anything actually sell?
    expect(s.listings.sellThroughRate).not.toBeNull();
    expect(s.moderation).toHaveProperty("openReports");
  });
});
