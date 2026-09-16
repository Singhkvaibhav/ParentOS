const request = require("supertest");
require("../tests/setupEnv");

jest.mock("../ai/controller", () => ({
  AiUnavailableError: class extends Error {},
  getAutoReply: jest.fn().mockResolvedValue("Mocked auto-reply."),
}));

const app = require("../server");
const db = require("../db");
const { resetDb } = require("./dbReset");
const { createVerifiedUser } = require("./helpers");

let agent;
let usingPostgis = false;

beforeAll(async () => {
  await app.dbReady;
  // hasPostgis() is only meaningful AFTER dbReady - detection happens
  // during initDb(), so reading it at module load (as the describe title
  // would) always reports false regardless of what the database has.
  usingPostgis = db.hasPostgis();
  await resetDb();
  const seller = await createVerifiedUser(app, { email: "geoseller@example.com" });
  agent = seller.agent;

  // Real Helsinki-area neighbourhoods at known separations, so the
  // assertions below are about genuine geography rather than made-up
  // coordinates that happen to sort correctly.
  await agent.post("/api/v1/listings").send({
    category: "toys", title: "Geo Kamppi item", priceCents: 500,
    condition: "Good", city: "Helsinki", area: "Kamppi",
  });
  await agent.post("/api/v1/listings").send({
    category: "toys", title: "Geo Malmi item", priceCents: 500,
    condition: "Good", city: "Helsinki", area: "Malmi",
  });
  await agent.post("/api/v1/listings").send({
    category: "toys", title: "Geo Espoo item", priceCents: 500,
    condition: "Good", city: "Espoo", area: "Espoon keskus",
  });
});

// These assertions must hold identically whether PostGIS is installed or
// not - the spatial path and the bounding-box fallback are two
// implementations of the same contract, and a deployment without PostGIS
// must behave the same, just less efficiently.
describe("distance search", () => {
  const CENTRAL_HELSINKI = "lat=60.1699&lng=24.9384";

  test("reports which implementation is in use, so a silent fallback is visible", () => {
    // Not an assertion about which path SHOULD run - both are valid, and a
    // deployment without PostGIS is explicitly supported. This exists so
    // the test output says which one was actually exercised, rather than
    // the spatial path silently going untested.
    console.log(`  → distance search path: ${usingPostgis ? "PostGIS (spatial index)" : "bounding-box fallback"}`);
    expect(typeof usingPostgis).toBe("boolean");
  });

  test("results are ordered nearest-first", async () => {
    const res = await request(app).get(`/api/v1/listings?${CENTRAL_HELSINKI}&q=Geo`);
    expect(res.status).toBe(200);
    const distances = res.body.listings.map((l) => l.distanceKm);
    const sorted = [...distances].sort((a, b) => a - b);
    expect(distances).toEqual(sorted);
  });

  test("every result carries a plausible distance", async () => {
    const res = await request(app).get(`/api/v1/listings?${CENTRAL_HELSINKI}&q=Geo`);
    for (const l of res.body.listings) {
      expect(typeof l.distanceKm).toBe("number");
      expect(l.distanceKm).toBeGreaterThanOrEqual(0);
      expect(l.distanceKm).toBeLessThan(100); // all fixtures are Helsinki-area
    }
  });

  test("maxDistance excludes anything beyond the radius", async () => {
    const near = await request(app).get(`/api/v1/listings?${CENTRAL_HELSINKI}&maxDistance=3&q=Geo`);
    const far = await request(app).get(`/api/v1/listings?${CENTRAL_HELSINKI}&maxDistance=50&q=Geo`);

    expect(near.body.total).toBeLessThan(far.body.total);
    for (const l of near.body.listings) {
      expect(l.distanceKm).toBeLessThanOrEqual(3);
    }
    // Kamppi is central; it must survive even a tight radius.
    expect(near.body.listings.some((l) => l.title === "Geo Kamppi item")).toBe(true);
  });

  test("a tiny radius around a remote point returns nothing, not an error", async () => {
    const res = await request(app).get("/api/v1/listings?lat=68.0&lng=27.0&maxDistance=1&q=Geo");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.listings).toHaveLength(0);
  });

  test("distance search returns the same pagination envelope as every other list", async () => {
    const res = await request(app).get(`/api/v1/listings?${CENTRAL_HELSINKI}&limit=2&q=Geo`);
    expect(res.body).toHaveProperty("total");
    expect(res.body).toHaveProperty("hasMore");
    expect(res.body).toHaveProperty("limit", 2);
    expect(res.body).toHaveProperty("offset", 0);
    expect(res.body.listings.length).toBeLessThanOrEqual(2);
  });

  test("pagination through distance results doesn't repeat or skip", async () => {
    const page1 = await request(app).get(`/api/v1/listings?${CENTRAL_HELSINKI}&limit=2&offset=0&q=Geo`);
    const page2 = await request(app).get(`/api/v1/listings?${CENTRAL_HELSINKI}&limit=2&offset=2&q=Geo`);

    const ids1 = page1.body.listings.map((l) => l.id);
    const ids2 = page2.body.listings.map((l) => l.id);
    expect(ids1.filter((id) => ids2.includes(id))).toHaveLength(0); // no overlap
    expect(ids1.length + ids2.length).toBe(page1.body.total);
  });

  test("distance search combines with a category filter", async () => {
    const res = await request(app).get(`/api/v1/listings?${CENTRAL_HELSINKI}&category=toys&q=Geo`);
    expect(res.body.listings.every((l) => l.category === "toys")).toBe(true);
  });

  test("moderated listings stay hidden from distance search too", async () => {
    const admin = await createVerifiedUser(app, { email: "geoadmin@example.com" });
    await db.query("UPDATE users SET is_admin = true WHERE id = $1", [admin.user.id]);

    const created = await agent.post("/api/v1/listings").send({
      category: "toys", title: "Geo hidden item", priceCents: 500,
      condition: "Good", city: "Helsinki", area: "Kamppi",
    });
    await admin.agent.post(`/api/v1/moderation/listings/${created.body.listing.id}/takedown`).send({ reason: "test" });

    const res = await request(app).get(`/api/v1/listings?${CENTRAL_HELSINKI}&q=Geo%20hidden`);
    expect(res.body.listings.some((l) => l.id === created.body.listing.id)).toBe(false);
  });
});
