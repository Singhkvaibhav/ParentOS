require("../tests/setupEnv");
const sharp = require("sharp");

jest.mock("../ai/controller", () => ({
  AiUnavailableError: class extends Error {},
  getAutoReply: jest.fn().mockResolvedValue("Mocked."),
}));

const app = require("../server");
const { resetDb } = require("./dbReset");
const { createVerifiedUser } = require("./helpers");

let agent;

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
  agent = (await createVerifiedUser(app, { email: "directupload@example.com" })).agent;
});

// Builds a JPEG carrying EXIF GPS, i.e. what a phone actually produces
// when someone photographs a cot in their living room.
async function jpegWithGpsExif() {
  return sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 100, b: 50 } } })
    .jpeg()
    .withExif({
      IFD0: { Copyright: "Test" },
      GPS: { GPSLatitudeRef: "N", GPSLongitudeRef: "E" },
    })
    .toBuffer();
}

describe("presigned direct upload", () => {
  test("requires authentication", async () => {
    const request = require("supertest");
    expect((await request(app).post("/api/uploads/presign").send({})).status).toBe(403);
  });

  test("issues an upload URL targeting quarantine, not the public prefix", async () => {
    const res = await agent.post("/api/uploads/presign").send({ contentType: "image/jpeg" });
    expect(res.status).toBe(200);
    expect(res.body.key).toMatch(/^quarantine\//);
    expect(res.body.uploadUrl).toBeTruthy();
    expect(res.body.method).toBe("PUT");
  });

  test("refuses to presign a non-image content type", async () => {
    const res = await agent.post("/api/uploads/presign").send({ contentType: "application/x-sh" });
    expect(res.status).toBe(400);
  });

  // The key round-trips through the client, so it must be re-checked
  // rather than trusted to overwrite an already-public object.
  test("a client can't redirect the upload at the public prefix", async () => {
    const res = await agent
      .put(`/api/uploads/direct/${encodeURIComponent("listings/existing.jpg")}`)
      .set("Content-Type", "image/jpeg")
      .send(Buffer.from("x"));
    expect(res.status).toBe(400);
  });

  test("finalize refuses a key that isn't in quarantine", async () => {
    const res = await agent.post("/api/uploads/finalize").send({ key: "listings/existing.jpg" });
    expect(res.status).toBe(400);
  });

  // The whole reason quarantine exists.
  test("the full flow strips EXIF GPS before the image becomes public", async () => {
    const original = await jpegWithGpsExif();
    // Confirm the fixture genuinely carries GPS, or the test proves nothing.
    expect((await sharp(original).metadata()).exif).toBeDefined();

    const presign = await agent.post("/api/uploads/presign").send({ contentType: "image/jpeg" });
    const { key, uploadUrl } = presign.body;

    const put = await agent.put(uploadUrl).set("Content-Type", "image/jpeg").send(original);
    expect(put.status).toBe(200);

    const finalize = await agent.post("/api/uploads/finalize").send({ key });
    expect(finalize.status).toBe(200);
    expect(finalize.body.url).toBeTruthy();
    expect(finalize.body.key).toMatch(/^listings\//);

    // Read the promoted object back and confirm the metadata is gone.
    const { readObject } = require("../storage");
    const published = await readObject(finalize.body.key);
    const meta = await sharp(published).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.format).toBe("jpeg");
  });

  test("garbage that isn't an image is rejected at finalize, not published", async () => {
    const presign = await agent.post("/api/uploads/presign").send({ contentType: "image/jpeg" });
    await agent.put(presign.body.uploadUrl).set("Content-Type", "image/jpeg").send(Buffer.from("not an image at all"));

    const finalize = await agent.post("/api/uploads/finalize").send({ key: presign.body.key });
    expect(finalize.status).toBe(400);
  });
});
