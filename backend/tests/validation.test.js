const request = require("supertest");
require("../tests/setupEnv");
const app = require("../server");
const { resetDb } = require("./dbReset");
const { createVerifiedUser } = require("./helpers");

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
});

// A non-numeric id reaching Postgres directly (e.g. `WHERE id = $1` with
// $1 = "not-a-number") throws a raw type-conversion error, which without
// validation upstream becomes an unhelpful 500 instead of a clean 400 -
// this was a real, systemic gap found by testing malformed input against
// every id-taking endpoint (see the "Tenth round" section of the README).
describe("id validation - malformed ids return 400, not 500", () => {
  let agent;
  let listing;

  beforeAll(async () => {
    const seller = await createVerifiedUser(app, { email: "validationseller@example.com" });
    agent = seller.agent;
    const res = await agent.post("/api/v1/listings").send({
      category: "toys", title: "Validation test toy", priceCents: 500, condition: "Good", city: "Helsinki", area: "Kamppi",
    });
    listing = res.body.listing;
  });

  test("GET /api/v1/listings/:id", async () => {
    const res = await request(app).get("/api/v1/listings/not-a-number");
    expect(res.status).toBe(400);
  });

  test("POST /api/v1/listings/:id/reserve", async () => {
    const res = await agent.post("/api/v1/listings/not-a-number/reserve");
    expect(res.status).toBe(400);
  });

  test("PATCH /api/v1/listings/:id", async () => {
    const res = await agent.patch("/api/v1/listings/not-a-number").send({ title: "x" });
    expect(res.status).toBe(400);
  });

  test("DELETE /api/v1/listings/:id", async () => {
    const res = await agent.delete("/api/v1/listings/not-a-number");
    expect(res.status).toBe(400);
  });

  test("POST /api/v1/messages/conversations/:id/reply", async () => {
    const res = await agent.post("/api/v1/messages/conversations/not-a-number/reply").send({ text: "hi" });
    expect(res.status).toBe(400);
  });

  test("GET /api/v1/users/:id", async () => {
    const res = await request(app).get("/api/v1/users/not-a-number");
    expect(res.status).toBe(400);
  });

  test("GET /api/v1/reviews/user/:userId", async () => {
    const res = await request(app).get("/api/v1/reviews/user/not-a-number");
    expect(res.status).toBe(400);
  });

  test("POST /api/v1/reviews (body revieweeId/listingId)", async () => {
    const res = await agent.post("/api/v1/reviews").send({ revieweeId: "not-a-number", listingId: listing.id, rating: 5 });
    expect(res.status).toBe(400);
  });

  test("POST /api/v1/transactions/checkout (body listingId)", async () => {
    const res = await agent.post("/api/v1/transactions/checkout").send({ listingId: "not-a-number" });
    expect(res.status).toBe(400);
  });

  test("POST /api/v1/favorites (body listingId)", async () => {
    const res = await agent.post("/api/v1/favorites").send({ listingId: "not-a-number" });
    expect(res.status).toBe(400);
  });

  test("DELETE /api/v1/favorites/:listingId", async () => {
    const res = await agent.delete("/api/v1/favorites/not-a-number");
    expect(res.status).toBe(400);
  });

  test("a real numeric id still works normally (the fix didn't break the happy path)", async () => {
    const res = await request(app).get(`/api/v1/listings/${listing.id}`);
    expect(res.status).toBe(200);
    expect(res.body.listing.id).toBe(listing.id);
  });
});

// Beyond ids: the other untrusted values a listing carries. Each of these
// was accepted before (or caused a 500), which meant the catalogue could
// hold listings no filter would ever match, or a price that overflowed the
// INTEGER column.
describe("listing field validation", () => {
  let agent;

  beforeAll(async () => {
    const seller = await createVerifiedUser(app, { email: "fieldvalidation@example.com" });
    agent = seller.agent;
  });

  const base = { category: "toys", title: "Valid toy", priceCents: 500, condition: "Good", city: "Helsinki", area: "Kamppi" };

  test("rejects a category outside the allowed set", async () => {
    const res = await agent.post("/api/v1/listings").send({ ...base, category: "weapons" });
    expect(res.status).toBe(400);
  });

  test("rejects a condition outside the allowed set", async () => {
    const res = await agent.post("/api/v1/listings").send({ ...base, condition: "Nonsense" });
    expect(res.status).toBe(400);
  });

  test("rejects a negative price", async () => {
    const res = await agent.post("/api/v1/listings").send({ ...base, priceCents: -500 });
    expect(res.status).toBe(400);
  });

  test("rejects a price large enough to overflow the INTEGER column", async () => {
    const res = await agent.post("/api/v1/listings").send({ ...base, priceCents: 999999999999 });
    expect(res.status).toBe(400); // was a raw 500 before the cap
  });

  test("rejects an over-long title", async () => {
    const res = await agent.post("/api/v1/listings").send({ ...base, title: "A".repeat(100000) });
    expect(res.status).toBe(400);
  });

  test("rejects an over-long description", async () => {
    const res = await agent.post("/api/v1/listings").send({ ...base, description: "A".repeat(50000) });
    expect(res.status).toBe(400);
  });

  test("an update can't sneak in a value that create would reject", async () => {
    const created = await agent.post("/api/v1/listings").send(base);
    const res = await agent.patch(`/api/v1/listings/${created.body.listing.id}`).send({ category: "weapons" });
    expect(res.status).toBe(400);
  });

  test("valid input is still accepted", async () => {
    const res = await agent.post("/api/v1/listings").send({ ...base, title: "Perfectly fine toy", priceCents: 1250 });
    expect(res.status).toBe(201);
    expect(res.body.listing.price_cents).toBe(1250);
  });
});
