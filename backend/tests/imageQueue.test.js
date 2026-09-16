require("../tests/setupEnv");

// (P1) The worker's image-processing job used to only call
// processQuarantinedImage() and stop - nothing updated the uploads row, so
// with a queue enabled the row stayed "uploaded" forever even after the
// public image existed. handleImageProcessingJob (worker.js) now owns the
// whole uploaded -> processed/failed transition; these tests exercise it
// directly against a fake BullMQ job, since the suite deliberately never
// requires a real Redis (see queue/index.js).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

const app = require("../server");
const { query } = require("../db");
const { resetDb } = require("./dbReset");
const { createVerifiedUser } = require("./helpers");
const { handleImageProcessingJob } = require("../worker");
const { QUARANTINE_PREFIX } = require("../storage");

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
});

function quarantinePath(key) {
  return path.resolve(__dirname, "../uploads", key);
}

async function writeQuarantineFile(bytes) {
  const key = `${QUARANTINE_PREFIX}${crypto.randomUUID()}.upload`;
  const filePath = quarantinePath(key);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
  return key;
}

async function insertUpload(userId, storageKey) {
  const { rows } = await query(
    `INSERT INTO uploads (user_id, storage_key, content_type, status) VALUES ($1, $2, 'image/jpeg', 'uploaded') RETURNING id`,
    [userId, storageKey]
  );
  return rows[0].id;
}

function fakeJob(data, { attemptsMade = 0, attempts = 3 } = {}) {
  return { data, attemptsMade, opts: { attempts } };
}

describe("worker: image-processing job completes the uploads state transition", () => {
  test("a successful job marks the upload processed with the public url/thumb, and removes the quarantine file", async () => {
    const u = await createVerifiedUser(app, { email: `imgqueue-ok-${Date.now()}@example.com` });
    const realImage = await sharp({ create: { width: 20, height: 20, channels: 3, background: "red" } }).jpeg().toBuffer();
    const key = await writeQuarantineFile(realImage);
    const uploadId = await insertUpload(u.user.id, key);

    await handleImageProcessingJob(fakeJob({ quarantineKey: key, uploadId }));

    const { rows } = await query("SELECT * FROM uploads WHERE id = $1", [uploadId]);
    expect(rows[0].status).toBe("processed");
    expect(rows[0].public_key).toBeTruthy();
    expect(rows[0].public_url).toBeTruthy();
    expect(rows[0].completed_at).toBeTruthy();

    // The quarantine copy still held the un-stripped original - it must be
    // gone, not just orphaned (this is bug #2: deleteObject vs deleteImage).
    expect(fs.existsSync(quarantinePath(key))).toBe(false);
  });

  test("a non-image upload is marked failed rather than left stuck as \"uploaded\" forever", async () => {
    const u = await createVerifiedUser(app, { email: `imgqueue-badimg-${Date.now()}@example.com` });
    const key = await writeQuarantineFile(Buffer.from("definitely not an image"));
    const uploadId = await insertUpload(u.user.id, key);

    await handleImageProcessingJob(fakeJob({ quarantineKey: key, uploadId }));

    const { rows } = await query("SELECT * FROM uploads WHERE id = $1", [uploadId]);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toMatch(/valid image/i);
    // Deterministic failure - not worth BullMQ retrying, so the job itself
    // resolves rather than throwing.
    expect(fs.existsSync(quarantinePath(key))).toBe(false);
  });

  test("a transient failure on the final allowed attempt is recorded as failed", async () => {
    const u = await createVerifiedUser(app, { email: `imgqueue-transient-final-${Date.now()}@example.com` });
    // No file ever written for this key - readObject throws ENOENT, which
    // is not an ImageProcessingError, i.e. the "unexpected/transient" path.
    const key = `${QUARANTINE_PREFIX}${crypto.randomUUID()}.upload`;
    const uploadId = await insertUpload(u.user.id, key);

    await expect(
      handleImageProcessingJob(fakeJob({ quarantineKey: key, uploadId }, { attemptsMade: 2, attempts: 3 }))
    ).rejects.toThrow();

    const { rows } = await query("SELECT * FROM uploads WHERE id = $1", [uploadId]);
    expect(rows[0].status).toBe("failed");
  });

  test("a transient failure with retries remaining leaves the row alone for BullMQ to retry", async () => {
    const u = await createVerifiedUser(app, { email: `imgqueue-transient-retry-${Date.now()}@example.com` });
    const key = `${QUARANTINE_PREFIX}${crypto.randomUUID()}.upload`;
    const uploadId = await insertUpload(u.user.id, key);

    await expect(
      handleImageProcessingJob(fakeJob({ quarantineKey: key, uploadId }, { attemptsMade: 0, attempts: 3 }))
    ).rejects.toThrow();

    const { rows } = await query("SELECT * FROM uploads WHERE id = $1", [uploadId]);
    expect(rows[0].status).toBe("uploaded");
  });
});
