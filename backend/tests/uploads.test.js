const request = require("supertest");
require("../tests/setupEnv");
const fs = require("fs");
const path = require("path");
const app = require("../server");
const { resetDb } = require("./dbReset");
const { createVerifiedUser, csrfAgent } = require("./helpers");

const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const createdFiles = [];

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
});

afterAll(() => {
  // These tests write real files to local disk (no S3 configured in test
  // env) - clean up after ourselves rather than littering backend/uploads/.
  for (const filePath of createdFiles) {
    try { fs.unlinkSync(filePath); } catch (e) { /* already gone, fine */ }
  }
});

function localPathFromUrl(url) {
  const key = new URL(url).pathname.replace(/^\/uploads\//, "");
  return path.resolve(__dirname, "../uploads", key);
}

describe("image uploads", () => {
  test("requires auth", async () => {
    const res = await (await csrfAgent(app)).post("/api/uploads").send({ imageDataUrl: TINY_PNG });
    expect(res.status).toBe(401);
  });

  test("requires imageDataUrl", async () => {
    const { agent } = await createVerifiedUser(app, { email: "uploadmissing@example.com" });
    const res = await agent.post("/api/uploads").send({});
    expect(res.status).toBe(400);
  });

  test("rejects data that isn't actually a valid image", async () => {
    const { agent } = await createVerifiedUser(app, { email: "uploadgarbage@example.com" });
    const fakeImage = "data:image/png;base64," + Buffer.from("this is not a real image").toString("base64");
    const res = await agent.post("/api/uploads").send({ imageDataUrl: fakeImage });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid image/i);
  });

  test("accepts a real image, resizes/re-encodes it, and the file is actually retrievable", async () => {
    const { agent } = await createVerifiedUser(app, { email: "uploadok@example.com" });
    const res = await agent.post("/api/uploads").send({ imageDataUrl: TINY_PNG });
    expect(res.status).toBe(201);
    expect(res.body.url).toMatch(/^http:\/\/localhost:4000\/uploads\/listings\/.+\.jpg$/);

    createdFiles.push(localPathFromUrl(res.body.url));

    const fetchRes = await request(app).get(new URL(res.body.url).pathname);
    expect(fetchRes.status).toBe(200);
    expect(fetchRes.headers["content-type"]).toMatch(/image\/jpeg/);
  });

  test("a listing can be created with a real uploaded photo_url", async () => {
    const { agent } = await createVerifiedUser(app, { email: "uploadlisting@example.com" });
    const uploadRes = await agent.post("/api/uploads").send({ imageDataUrl: TINY_PNG });
    createdFiles.push(localPathFromUrl(uploadRes.body.url));

    const listingRes = await agent.post("/api/listings").send({
      category: "toys", title: "Toy with photo", priceCents: 900, condition: "Good", city: "Helsinki", area: "Kamppi", photoUrl: uploadRes.body.url,
    });
    expect(listingRes.status).toBe(201);
    expect(listingRes.body.listing.photo_url).toBe(uploadRes.body.url);
  });
});

// (P1 #11) Without cleanup, every deleted listing and every replaced photo
// leaves a file behind forever - storage cost for data nothing references.
describe("image cleanup", () => {
  test("deleting a listing removes its stored image from disk", async () => {
    const { agent } = await createVerifiedUser(app, { email: "cleanupdelete@example.com" });
    const uploadRes = await agent.post("/api/uploads").send({ imageDataUrl: TINY_PNG });
    const filePath = localPathFromUrl(uploadRes.body.url);
    expect(fs.existsSync(filePath)).toBe(true);

    const listingRes = await agent.post("/api/listings").send({
      category: "toys", title: "Doomed toy", priceCents: 900, condition: "Good", city: "Helsinki", area: "Kamppi", photoUrl: uploadRes.body.url,
    });

    const deleteRes = await agent.delete(`/api/listings/${listingRes.body.listing.id}`);
    expect(deleteRes.status).toBe(200);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  test("replacing a listing's photo removes the old file but keeps the new one", async () => {
    const { agent } = await createVerifiedUser(app, { email: "cleanupreplace@example.com" });

    const firstUpload = await agent.post("/api/uploads").send({ imageDataUrl: TINY_PNG });
    const oldPath = localPathFromUrl(firstUpload.body.url);
    const listingRes = await agent.post("/api/listings").send({
      category: "toys", title: "Toy getting a new photo", priceCents: 900, condition: "Good", city: "Helsinki", area: "Kamppi", photoUrl: firstUpload.body.url,
    });

    const secondUpload = await agent.post("/api/uploads").send({ imageDataUrl: TINY_PNG });
    const newPath = localPathFromUrl(secondUpload.body.url);
    createdFiles.push(newPath);

    await agent.patch(`/api/listings/${listingRes.body.listing.id}`).send({ photoUrl: secondUpload.body.url });

    expect(fs.existsSync(oldPath)).toBe(false); // replaced - nothing references it now
    expect(fs.existsSync(newPath)).toBe(true); // still in use
  });

  test("an update that doesn't touch the photo leaves the file alone", async () => {
    const { agent } = await createVerifiedUser(app, { email: "cleanupkeep@example.com" });
    const uploadRes = await agent.post("/api/uploads").send({ imageDataUrl: TINY_PNG });
    const filePath = localPathFromUrl(uploadRes.body.url);
    createdFiles.push(filePath);

    const listingRes = await agent.post("/api/listings").send({
      category: "toys", title: "Toy keeping its photo", priceCents: 900, condition: "Good", city: "Helsinki", area: "Kamppi", photoUrl: uploadRes.body.url,
    });

    await agent.patch(`/api/listings/${listingRes.body.listing.id}`).send({ title: "Renamed, same photo" });

    expect(fs.existsSync(filePath)).toBe(true);
  });
});
