const app = require("../server");
const { resetDb } = require("./dbReset");
const { createVerifiedUser } = require("./helpers");

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
});

async function createListing(sellerAgent, overrides = {}) {
  const res = await sellerAgent.post("/api/listings").send({
    category: "toys", title: "Favorite-able toy", priceCents: 1500, condition: "Good", city: "Helsinki", area: "Kamppi", ...overrides,
  });
  return res.body.listing;
}

describe("favorites", () => {
  test("requires auth", async () => {
    const request = require("supertest");
    const res = await request(app).get("/api/favorites");
    expect(res.status).toBe(401);
  });

  test("favoriting a nonexistent listing returns a clean 404, not a raw DB error", async () => {
    const { agent } = await createVerifiedUser(app, { email: "favnotfound@example.com" });
    const res = await agent.post("/api/favorites").send({ listingId: 999999 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Listing not found.");
  });

  test("add, list, and remove a favorite", async () => {
    const seller = await createVerifiedUser(app, { email: "favseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "favbuyer@example.com" });
    const listing = await createListing(seller.agent);

    const addRes = await buyer.agent.post("/api/favorites").send({ listingId: listing.id });
    expect(addRes.status).toBe(201);

    const listRes = await buyer.agent.get("/api/favorites");
    expect(listRes.status).toBe(200);
    expect(listRes.body.favorites.map((l) => l.id)).toContain(listing.id);

    const removeRes = await buyer.agent.delete(`/api/favorites/${listing.id}`);
    expect(removeRes.status).toBe(200);

    const afterRemove = await buyer.agent.get("/api/favorites");
    expect(afterRemove.body.favorites.map((l) => l.id)).not.toContain(listing.id);
  });

  test("favoriting the same listing twice doesn't error or duplicate", async () => {
    const seller = await createVerifiedUser(app, { email: "favdupseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "favdupbuyer@example.com" });
    const listing = await createListing(seller.agent);

    await buyer.agent.post("/api/favorites").send({ listingId: listing.id });
    const secondAdd = await buyer.agent.post("/api/favorites").send({ listingId: listing.id });
    expect(secondAdd.status).toBe(201); // idempotent, not an error

    const listRes = await buyer.agent.get("/api/favorites");
    const matches = listRes.body.favorites.filter((l) => l.id === listing.id);
    expect(matches).toHaveLength(1);
  });

  test("favorites are scoped per-user - one buyer's favorite doesn't leak into another's list", async () => {
    const seller = await createVerifiedUser(app, { email: "favscopeseller@example.com" });
    const buyerA = await createVerifiedUser(app, { email: "favscopebuyera@example.com" });
    const buyerB = await createVerifiedUser(app, { email: "favscopebuyerb@example.com" });
    const listing = await createListing(seller.agent);

    await buyerA.agent.post("/api/favorites").send({ listingId: listing.id });

    const buyerBList = await buyerB.agent.get("/api/favorites");
    expect(buyerBList.body.favorites.map((l) => l.id)).not.toContain(listing.id);
  });
});
