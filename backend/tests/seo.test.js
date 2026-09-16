const request = require("supertest");
require("../tests/setupEnv");

jest.mock("../ai/controller", () => ({
  AiUnavailableError: class extends Error {},
  getAutoReply: jest.fn().mockResolvedValue("Mocked auto-reply."),
}));

const app = require("../server");
const { createVerifiedUser } = require("./helpers");
const { resetDb } = require("./dbReset");

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
});

// These are unauthenticated, crawler/link-preview-bot-facing routes (see
// seo/routes.js) - no agent/cookie needed, a plain request is the accurate
// simulation of what actually hits them in production.
describe("robots.txt and sitemap.xml", () => {
  test("robots.txt points at the sitemap", async () => {
    const res = await request(app).get("/robots.txt");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.text).toMatch(/Sitemap: .+\/sitemap\.xml/);
    expect(res.text).toMatch(/Disallow: \/moderation/);
  });

  test("sitemap.xml is valid-shaped XML that includes an active listing", async () => {
    const seller = await createVerifiedUser(app, { email: "seo-seller1@example.com" });
    const created = await seller.agent.post("/api/listings").send({
      category: "toys", title: "Sitemap test toy", priceCents: 1500, condition: "Good", city: "Helsinki", area: "Kamppi",
    });

    const res = await request(app).get("/sitemap.xml");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/xml/);
    expect(res.text).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
    expect(res.text).toContain(`<loc>${(process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "")}/listing/${created.body.listing.id}</loc>`);
  });

  test("a moderated (taken-down) listing does not appear in the sitemap", async () => {
    const seller = await createVerifiedUser(app, { email: "seo-seller2@example.com" });
    const created = await seller.agent.post("/api/listings").send({
      category: "toys", title: "Should be hidden", priceCents: 1500, condition: "Good", city: "Helsinki", area: "Kamppi",
    });
    const { query } = require("../db");
    await query("UPDATE listings SET moderated_at = now() WHERE id = $1", [created.body.listing.id]);

    const res = await request(app).get("/sitemap.xml");
    expect(res.text).not.toContain(`/listing/${created.body.listing.id}<`);
  });
});

describe("GET /listing/:id (crawler/share-link shell)", () => {
  test("a real listing gets its own title and Open Graph tags", async () => {
    const seller = await createVerifiedUser(app, { email: "seo-seller3@example.com" });
    const created = await seller.agent.post("/api/listings").send({
      category: "toys",
      title: "Wooden train set",
      priceCents: 2500,
      condition: "Good",
      city: "Helsinki",
      area: "Kamppi",
      description: "Barely used wooden train set, all pieces included.",
    });
    const listing = created.body.listing;

    const res = await request(app).get(`/listing/${listing.id}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain(`<title>${listing.title} · €25 · Uusiksi</title>`);
    expect(res.text).toContain('property="og:title" content="Wooden train set · €25 · Uusiksi"');
    expect(res.text).toContain("Barely used wooden train set");
    // The real SPA shell (script tag etc.) must still be present so a real
    // browser boots the app exactly as it would from the static file.
    expect(res.text).toContain('id="root"');
  });

  test("a nonexistent listing gets a 404 shell, not a raw error", async () => {
    const res = await request(app).get("/listing/999999999");
    expect(res.status).toBe(404);
    expect(res.text).toContain("Listing not found");
  });

  test("a non-numeric id gets the same 404 shell instead of a Postgres error", async () => {
    const res = await request(app).get("/listing/not-a-number");
    expect(res.status).toBe(404);
    expect(res.text).toContain("Listing not found");
  });

  test("a moderated listing 404s for an anonymous viewer", async () => {
    const seller = await createVerifiedUser(app, { email: "seo-seller4@example.com" });
    const created = await seller.agent.post("/api/listings").send({
      category: "toys", title: "Taken down item", priceCents: 1000, condition: "Good", city: "Helsinki", area: "Kamppi",
    });
    const { query } = require("../db");
    await query("UPDATE listings SET moderated_at = now() WHERE id = $1", [created.body.listing.id]);

    const res = await request(app).get(`/listing/${created.body.listing.id}`);
    expect(res.status).toBe(404);
  });
});
