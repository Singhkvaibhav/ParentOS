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

// The presigned key used to be the only credential: any authenticated user
// holding a `quarantine/...` key could write to it or finalize it. A UUID
// is unguessable, but unguessable is not authorized - keys travel through
// logs, browser history, proxies and error reports, and any of those turns
// "hard to guess" into "known".
describe("upload keys are tied to the user who requested them", () => {
  let owner, attacker;

  beforeAll(async () => {
    const { createVerifiedUser } = require("./helpers");
    owner = await createVerifiedUser(app, { email: "uploadowner@example.com" });
    attacker = await createVerifiedUser(app, { email: "uploadattacker@example.com" });
  });

  test("a presign records the key against the requesting user", async () => {
    const { query } = require("../db");
    const res = await owner.agent.post("/api/uploads/presign").send({ contentType: "image/jpeg" });
    expect(res.status).toBe(200);

    const { rows } = await query("SELECT user_id, status FROM uploads WHERE storage_key = $1", [res.body.key]);
    expect(rows[0].user_id).toBe(owner.user.id);
    expect(rows[0].status).toBe("pending");
  });

  test("another user cannot write to someone else's quarantine key", async () => {
    const presign = await owner.agent.post("/api/uploads/presign").send({ contentType: "image/jpeg" });

    const res = await attacker.agent
      .put(presign.body.uploadUrl)
      .set("Content-Type", "image/jpeg")
      .send(Buffer.from("attacker payload"));

    // 404 rather than 403: confirming the key exists but belongs to
    // someone else is exactly what an attacker probing keys wants to learn.
    expect(res.status).toBe(404);
  });

  test("another user cannot finalize someone else's upload", async () => {
    const presign = await owner.agent.post("/api/uploads/presign").send({ contentType: "image/jpeg" });
    const jpeg = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg().toBuffer();
    await owner.agent.put(presign.body.uploadUrl).set("Content-Type", "image/jpeg").send(jpeg);

    const res = await attacker.agent.post("/api/uploads/finalize").send({ key: presign.body.key });
    expect(res.status).toBe(404);
  });

  test("the owner's own flow still works end to end", async () => {
    const presign = await owner.agent.post("/api/uploads/presign").send({ contentType: "image/jpeg" });
    const jpeg = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 9, g: 9, b: 9 } } })
      .jpeg().toBuffer();

    expect((await owner.agent.put(presign.body.uploadUrl).set("Content-Type", "image/jpeg").send(jpeg)).status).toBe(200);
    const finalize = await owner.agent.post("/api/uploads/finalize").send({ key: presign.body.key });
    expect(finalize.status).toBe(200);

    const { query } = require("../db");
    const { rows } = await query("SELECT status, public_key FROM uploads WHERE storage_key = $1", [presign.body.key]);
    expect(rows[0].status).toBe("processed");
    expect(rows[0].public_key).toMatch(/^listings\//);
  });

  test("a key that was never issued is rejected", async () => {
    const res = await owner.agent.post("/api/uploads/finalize")
      .send({ key: "quarantine/00000000-0000-0000-0000-000000000000.upload" });
    expect(res.status).toBe(404);
  });

  test("an upload can't be written twice", async () => {
    const presign = await owner.agent.post("/api/uploads/presign").send({ contentType: "image/jpeg" });
    const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 5, g: 5, b: 5 } } })
      .jpeg().toBuffer();

    await owner.agent.put(presign.body.uploadUrl).set("Content-Type", "image/jpeg").send(jpeg);
    const second = await owner.agent.put(presign.body.uploadUrl).set("Content-Type", "image/jpeg").send(jpeg);
    expect(second.status).toBe(409);
  });

  test("an expired presign is refused", async () => {
    const { query } = require("../db");
    const presign = await owner.agent.post("/api/uploads/presign").send({ contentType: "image/jpeg" });
    await query("UPDATE uploads SET expires_at = now() - interval '1 minute' WHERE storage_key = $1", [presign.body.key]);

    const res = await owner.agent.put(presign.body.uploadUrl)
      .set("Content-Type", "image/jpeg").send(Buffer.from("late"));
    expect(res.status).toBe(410);
  });

  // Abandoned presigns previously left orphaned objects with nothing
  // recording they existed, so they could never be found to clean up.
  test("abandoned uploads can be swept", async () => {
    const { query } = require("../db");
    const { sweepAbandoned } = require("../services/uploadService");
    const presign = await owner.agent.post("/api/uploads/presign").send({ contentType: "image/jpeg" });
    await query("UPDATE uploads SET expires_at = now() - interval '2 hours' WHERE storage_key = $1", [presign.body.key]);

    const result = await sweepAbandoned();
    expect(result.swept).toBeGreaterThanOrEqual(1);

    const { rows } = await query("SELECT status FROM uploads WHERE storage_key = $1", [presign.body.key]);
    expect(rows[0].status).toBe("failed");
  });
});
