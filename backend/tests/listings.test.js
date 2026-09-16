const request = require("supertest");
require("../tests/setupEnv");

const mockPaymentIntentsCreate = jest.fn().mockImplementation(async ({ amount, metadata }) => ({
  id: `pi_test_${Math.random().toString(36).slice(2)}`,
  client_secret: "secret_test",
  amount,
  metadata,
}));
jest.mock("stripe", () => {
  return jest.fn().mockImplementation(() => ({
    paymentIntents: { create: mockPaymentIntentsCreate },
    refunds: { create: jest.fn() },
    webhooks: { constructEvent: jest.fn() },
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
  return createListingBase(sellerAgent, { category: "toys", title: "State machine test toy", priceCents: 1000, ...overrides });
}

describe("listing status state machine", () => {
  test("valid transitions: active -> reserved -> sold -> active (relist)", async () => {
    const seller = await createVerifiedUser(app, { email: "smseller1@example.com" });
    const listing = await createListing(seller.agent);

    const toReserved = await seller.agent.post(`/api/v1/listings/${listing.id}/reserve`);
    expect(toReserved.status).toBe(200);
    expect(toReserved.body.listing.status).toBe("reserved");

    const toSold = await seller.agent.post(`/api/v1/listings/${listing.id}/sold`);
    expect(toSold.status).toBe(200);
    expect(toSold.body.listing.status).toBe("sold");

    const relisted = await seller.agent.post(`/api/v1/listings/${listing.id}/relist`);
    expect(relisted.status).toBe(200);
    expect(relisted.body.listing.status).toBe("active");
  });

  test("invalid transition is rejected: can't relist an already-active listing", async () => {
    const seller = await createVerifiedUser(app, { email: "smseller2@example.com" });
    const listing = await createListing(seller.agent); // starts 'active'

    const res = await seller.agent.post(`/api/v1/listings/${listing.id}/relist`);
    expect(res.status).toBe(409);
  });

  test("invalid transition is rejected: can't mark an active listing 'active' again via reserve twice", async () => {
    const seller = await createVerifiedUser(app, { email: "smseller3@example.com" });
    const listing = await createListing(seller.agent);
    await seller.agent.post(`/api/v1/listings/${listing.id}/sold`); // active -> sold

    const res = await seller.agent.post(`/api/v1/listings/${listing.id}/reserve`); // sold -> reserved is not allowed
    expect(res.status).toBe(409);
  });

  // This is the exact scenario flagged in review: a buyer starts checkout
  // (listing becomes 'reserved' with a real pending Stripe PaymentIntent),
  // and the seller tries to relist or mark it sold while that payment is
  // still in flight. Both must be blocked - otherwise a second buyer could
  // purchase the same item, or the original payment could later succeed
  // against a listing already sold to someone else.
  test("relist is blocked while a real pending transaction exists on the listing", async () => {
    const seller = await createVerifiedUser(app, { email: "smpendingseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "smpendingbuyer@example.com" });
    const listing = await createListing(seller.agent);

    const checkoutRes = await buyer.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });
    expect(checkoutRes.status).toBe(201);

    const midway = await request(app).get(`/api/v1/listings/${listing.id}`);
    expect(midway.body.listing.status).toBe("reserved");

    const relistAttempt = await seller.agent.post(`/api/v1/listings/${listing.id}/relist`);
    expect(relistAttempt.status).toBe(409);
    expect(relistAttempt.body.error).toMatch(/payment in progress/i);

    // The listing must still be reserved - the blocked attempt didn't
    // partially apply anything.
    const after = await request(app).get(`/api/v1/listings/${listing.id}`);
    expect(after.body.listing.status).toBe("reserved");
  });

  test("mark sold is also blocked while a real pending transaction exists", async () => {
    const seller = await createVerifiedUser(app, { email: "smpendingseller2@example.com" });
    const buyer = await createVerifiedUser(app, { email: "smpendingbuyer2@example.com" });
    const listing = await createListing(seller.agent);

    await buyer.agent.post("/api/v1/transactions/checkout").send({ listingId: listing.id });

    const res = await seller.agent.post(`/api/v1/listings/${listing.id}/sold`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/payment in progress/i);
  });

  test("a non-owner can't change a listing's status", async () => {
    const seller = await createVerifiedUser(app, { email: "smowner@example.com" });
    const stranger = await createVerifiedUser(app, { email: "smstranger@example.com" });
    const listing = await createListing(seller.agent);

    const res = await stranger.agent.post(`/api/v1/listings/${listing.id}/reserve`);
    expect(res.status).toBe(403);
  });
});

// (P2 #17) The non-distance path previously returned no `total` at all
// while the distance path did, so a client had no reliable way to know how
// many results existed or whether to show a "next page" control.
describe("pagination metadata", () => {
  let agent;

  beforeAll(async () => {
    const seller = await createVerifiedUser(app, { email: "paginationseller@example.com" });
    agent = seller.agent;
    for (let i = 0; i < 5; i++) {
      await createListing(agent, { title: `Pagination item ${i}`, category: "accessories" });
    }
  });

  test("returns total and hasMore, consistently across pages", async () => {
    const page1 = await request(app).get("/api/v1/listings?category=accessories&limit=2&offset=0");
    expect(page1.body.listings).toHaveLength(2);
    expect(page1.body.total).toBeGreaterThanOrEqual(5);
    expect(page1.body.hasMore).toBe(true);
    expect(page1.body.limit).toBe(2);
    expect(page1.body.offset).toBe(0);

    const lastPage = await request(app).get(`/api/v1/listings?category=accessories&limit=2&offset=${page1.body.total - 1}`);
    expect(lastPage.body.hasMore).toBe(false);
  });

  test("an offset past the end returns an empty page, not an error", async () => {
    const res = await request(app).get("/api/v1/listings?category=accessories&limit=2&offset=9999");
    expect(res.status).toBe(200);
    expect(res.body.listings).toHaveLength(0);
    expect(res.body.hasMore).toBe(false);
  });

  test("the distance-filtered path returns the same envelope shape", async () => {
    const res = await request(app).get("/api/v1/listings?lat=60.1699&lng=24.9384&maxDistance=10&limit=2");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("total");
    expect(res.body).toHaveProperty("hasMore");
    expect(res.body).toHaveProperty("limit");
    expect(res.body).toHaveProperty("offset");
  });
});

// (P2 #16) Search was `ILIKE '%term%'`, which can't use an index (leading
// wildcard) and scanned every active listing. Now an indexed tsvector with
// prefix matching and relevance ranking.
describe("full-text search", () => {
  let agent;

  beforeAll(async () => {
    const seller = await createVerifiedUser(app, { email: "searchseller@example.com" });
    agent = seller.agent;
    await createListing(agent, { title: "Reima winter overalls", description: "Warm and waterproof", category: "clothes" });
    await createListing(agent, { title: "Summer sandals", description: "Barely worn winter alternative", category: "clothes" });
    await createListing(agent, { title: "Wooden train set", description: "Complete set", category: "toys" });
  });

  test("finds a listing by a word in its title", async () => {
    const res = await request(app).get("/api/v1/listings?q=overalls");
    expect(res.body.listings.some((l) => l.title === "Reima winter overalls")).toBe(true);
  });

  test("finds a listing by a word in its description", async () => {
    const res = await request(app).get("/api/v1/listings?q=waterproof");
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });

  test("prefix-matches, so a partly-typed word still finds results", async () => {
    const res = await request(app).get("/api/v1/listings?q=overal");
    expect(res.body.listings.some((l) => l.title === "Reima winter overalls")).toBe(true);
  });

  test("ranks title matches above description-only matches", async () => {
    // "winter" is in one listing's TITLE and another's DESCRIPTION - the
    // title match should come first (setweight A vs B in migration 004).
    const res = await request(app).get("/api/v1/listings?q=winter");
    expect(res.body.total).toBeGreaterThanOrEqual(2);
    expect(res.body.listings[0].title).toBe("Reima winter overalls");
  });

  test("multiple terms narrow rather than widen the results", async () => {
    const oneTerm = await request(app).get("/api/v1/listings?q=winter");
    const twoTerms = await request(app).get("/api/v1/listings?q=winter%20overalls");
    expect(twoTerms.body.total).toBeLessThanOrEqual(oneTerm.body.total);
  });

  test("a term matching nothing returns an empty result, not an error", async () => {
    const res = await request(app).get("/api/v1/listings?q=zzzznotathinganywhere");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  test("tsquery operators typed by a user are treated literally, not as syntax", async () => {
    // Raw '&', '!', ':*' would be a syntax error passed straight into
    // to_tsquery - they must be stripped, not crash the endpoint.
    const res = await request(app).get("/api/v1/listings?q=" + encodeURIComponent("&!:* winter"));
    expect(res.status).toBe(200);
  });

  test("search combines with a category filter", async () => {
    const res = await request(app).get("/api/v1/listings?q=set&category=toys");
    expect(res.status).toBe(200);
    expect(res.body.listings.every((l) => l.category === "toys")).toBe(true);
  });
});
