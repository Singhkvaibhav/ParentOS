// Pluggable image storage: uses S3-compatible object storage (AWS S3,
// Cloudflare R2, Backblaze B2, MinIO for local dev - anything speaking the
// S3 API) when S3_* env vars are configured, and falls back to writing
// files to backend/uploads/ (served statically) otherwise, so this runs out
// of the box without requiring a cloud account first.
//
// To go live: create a bucket with your provider of choice, set
// S3_BUCKET / S3_REGION / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (and
// S3_ENDPOINT + S3_PUBLIC_URL_BASE for R2/MinIO/non-AWS providers) in .env.
// No code changes needed - the same upload() call switches backends.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const logger = require("../logger");

const USE_S3 = !!(process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);

function parseDataUrl(dataUrl) {
  const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error("Expected a base64 image data URL.");
  const [, mimeType, base64] = match;
  const ext = mimeType.split("/")[1].replace("jpeg", "jpg");
  return { buffer: Buffer.from(base64, "base64"), ext, mimeType };
}

async function uploadToS3(buffer, key, mimeType) {
  // Lazily required so the package is only needed if S3 is actually configured.
  const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
  const client = new S3Client({
    region: process.env.S3_REGION || "auto",
    endpoint: process.env.S3_ENDPOINT || undefined, // needed for R2/MinIO, omit for real AWS S3
    forcePathStyle: !!process.env.S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  });
  await client.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
  }));
  const base = process.env.S3_PUBLIC_URL_BASE || `https://${process.env.S3_BUCKET}.s3.${process.env.S3_REGION}.amazonaws.com`;
  return `${base.replace(/\/$/, "")}/${key}`;
}

function uploadToDisk(buffer, key) {
  const uploadsDir = path.resolve(__dirname, "../uploads");
  const filePath = path.join(uploadsDir, key);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
  const base = process.env.LOCAL_UPLOADS_URL_BASE || "http://localhost:4000";
  return `${base.replace(/\/$/, "")}/uploads/${key}`;
}

// Persists an already-processed buffer (e.g. resized/re-encoded by the
// uploads route with sharp) and returns a permanent public URL.
async function saveBuffer(buffer, ext, mimeType) {
  const key = `listings/${crypto.randomUUID()}.${ext}`;
  if (USE_S3) return uploadToS3(buffer, key, mimeType);
  return uploadToDisk(buffer, key);
}

// Convenience wrapper for any caller that just has a raw data URL and
// doesn't need to process it first (kept for simplicity/back-compat).
async function saveImage(dataUrl) {
  const { buffer, ext, mimeType } = parseDataUrl(dataUrl);
  return saveBuffer(buffer, ext, mimeType);
}

// Deletes a previously-stored image given the URL that saveBuffer
// returned. Best-effort by design: a failure here is logged but never
// thrown, because an orphaned file is a housekeeping problem, not a reason
// to fail the user's actual request (deleting their listing, replacing
// their photo). Returns whether it succeeded, mostly so tests can assert.
//
// Silently ignores URLs that don't look like ones we issued - an
// externally-hosted photo_url (or a malformed one) must never cause us to
// attempt a delete against an arbitrary path.
async function deleteImage(url) {
  if (!url || typeof url !== "string") return false;

  const key = extractKey(url);
  if (!key) return false;

  try {
    if (USE_S3) {
      const { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3");
      const client = new S3Client({
        region: process.env.S3_REGION || "auto",
        endpoint: process.env.S3_ENDPOINT || undefined,
        forcePathStyle: !!process.env.S3_ENDPOINT,
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        },
      });
      await client.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
    } else {
      const filePath = path.resolve(__dirname, "../uploads", key);
      // Guard against a crafted key escaping the uploads directory - the
      // key comes from a stored URL, but defense in depth on a filesystem
      // delete is cheap insurance.
      const uploadsRoot = path.resolve(__dirname, "../uploads");
      if (!filePath.startsWith(uploadsRoot + path.sep)) return false;
      await fs.promises.unlink(filePath);
    }
    return true;
  } catch (e) {
    if (e.code !== "ENOENT") logger.warn("image_delete_failed", { key, err: e });
    return false;
  }
}

// Pulls the storage key ("listings/<uuid>.jpg") back out of a URL we
// issued, whether it points at S3 or the local /uploads route.
function extractKey(url) {
  const match = /\/(listings\/[A-Za-z0-9-]+\.[A-Za-z0-9]+)(?:\?|$)/.exec(url);
  return match ? match[1] : null;
}

// --- Direct (presigned) uploads ------------------------------------------
//
// (#13) The browser uploads straight to object storage instead of sending
// the image through Node. That removes the application server from the
// image payload path entirely.
//
// CRITICAL: a direct upload bypasses the sharp re-encode in images/routes,
// which is what rejects non-images and STRIPS EXIF. For a marketplace
// where parents photograph items inside their homes, EXIF GPS is a home
// address - publishing it would be a serious privacy failure, and worse
// here than in most products because the listings are children's items.
//
// So presigned uploads land in a QUARANTINE prefix that is never served
// publicly. A background job then downloads, validates, strips and
// re-encodes the image before promoting it to the public prefix. The
// object only becomes reachable once it has been through the same
// processing the inline path always did.
const QUARANTINE_PREFIX = "quarantine/";
const PUBLIC_PREFIX = "listings/";

function quarantineKeyFor(ext = "jpg") {
  return `${QUARANTINE_PREFIX}${crypto.randomUUID()}.${ext}`;
}

async function createPresignedUpload({ contentType = "image/jpeg" } = {}) {
  const key = quarantineKeyFor("upload");

  if (USE_S3) {
    const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
    const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
    const client = new S3Client({
      region: process.env.S3_REGION || "auto",
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: !!process.env.S3_ENDPOINT,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
    });
    const uploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, ContentType: contentType }),
      { expiresIn: 300 } // short-lived: the browser uploads immediately or not at all
    );
    return { uploadUrl, key, method: "PUT" };
  }

  // Local driver: exposes the SAME two-step flow against a local endpoint,
  // so the browser code path is identical in development and production.
  // Without this, direct upload would only ever be exercised in prod -
  // which is exactly where an untested path shouldn't first run.
  return { uploadUrl: `/api/v1/uploads/direct/${encodeURIComponent(key)}`, key, method: "PUT" };
}

async function readObject(key) {
  if (USE_S3) {
    const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
    const client = new S3Client({
      region: process.env.S3_REGION || "auto",
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: !!process.env.S3_ENDPOINT,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
    });
    const res = await client.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
    return Buffer.concat(await res.Body.toArray());
  }

  // Mirrors uploadToDisk: keys keep their prefix on disk, so quarantine
  // and public objects stay in separate directories locally too.
  return fs.promises.readFile(path.resolve(__dirname, "../uploads", key));
}

async function writeObject(key, buffer) {
  if (USE_S3) return uploadToS3(buffer, key, "image/octet-stream");
  const filePath = path.resolve(__dirname, "../uploads", key);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, buffer);
  const base = process.env.LOCAL_UPLOADS_URL_BASE || "http://localhost:4000";
  return `${base.replace(/\/$/, "")}/uploads/${key}`;
}

module.exports = {
  createPresignedUpload,
  readObject,
  writeObject,
  QUARANTINE_PREFIX,
  PUBLIC_PREFIX, saveImage, saveBuffer, parseDataUrl, deleteImage, usingS3: USE_S3 };
