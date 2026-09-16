const express = require("express");
const sharp = require("sharp");
const logger = require("../logger");
const requireAuth = require("../middleware/requireAuth");
const { saveBuffer, parseDataUrl } = require("../storage");
const { makeThumbnail } = require("../services/thumbnailService");

const router = express.Router();

const MAX_DIMENSION = 1280;     // longest side, in pixels, after resizing
const MAX_OUTPUT_BYTES = 3 * 1024 * 1024; // 3MB safety cap after re-encoding
const JPEG_QUALITY = 78;

// This route gets its own (larger) JSON body limit - everything else in the
// app uses a much smaller default (see server.js) so a stray large payload
// elsewhere can't tie up memory.
router.post("/", express.json({ limit: "6mb" }), requireAuth, async (req, res) => {
  const { imageDataUrl } = req.body;
  if (!imageDataUrl) return res.status(400).json({ error: "imageDataUrl is required." });

  let buffer;
  try {
    ({ buffer } = parseDataUrl(imageDataUrl));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Never trust that the client actually compressed/resized the image -
  // decode and re-encode it ourselves. This also rejects anything that
  // isn't a real image (sharp throws on garbage/malicious payloads) and
  // strips embedded metadata as a side effect of re-encoding.
  let processed;
  try {
    processed = await sharp(buffer)
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
  } catch (e) {
    return res.status(400).json({ error: "That doesn't look like a valid image." });
  }

  if (processed.length > MAX_OUTPUT_BYTES) {
    return res.status(400).json({ error: "Image is still too large after resizing - try a smaller photo." });
  }

  try {
    const url = await saveBuffer(processed, "jpg", "image/jpeg");
    // Resized from the original `buffer`, not `processed` - see
    // thumbnailService.js for why. Best-effort: a thumbnail failure
    // shouldn't lose the upload the user is actually waiting on, so this
    // falls back to no thumbnail rather than failing the whole request.
    const thumbUrl = await makeThumbnail(buffer)
      .then((thumb) => saveBuffer(thumb, "jpg", "image/jpeg"))
      .catch((e) => {
        logger.warn("thumbnail_generation_failed", { requestId: req.id, err: e });
        return null;
      });
    res.status(201).json({ url, thumbUrl });
  } catch (e) {
    logger.error("image_upload_failed", { requestId: req.id, err: e });
    res.status(500).json({ error: "Could not store that image." });
  }
});

// --- Direct (presigned) upload flow --------------------------------------
//
// Three steps: ask for a URL, PUT the bytes straight to storage, then tell
// the backend to process what landed. Every step verifies the key belongs
// to the caller - the key itself is not a credential.

// Step 1: issue a short-lived upload URL, recorded against this user.
router.post("/presign", express.json(), requireAuth, async (req, res) => {
  const { createUpload, UploadError } = require("../services/uploadService");
  try {
    res.json(await createUpload(req.user.id, { contentType: req.body?.contentType }));
  } catch (e) {
    if (e instanceof UploadError) return res.status(e.status).json({ error: e.message, code: e.code });
    throw e;
  }
});

// Step 2 (local driver only): stands in for the object store so the
// browser flow is identical in development. With S3 configured the browser
// PUTs to Amazon/R2 and never reaches this route.
router.put("/direct/:key", requireAuth, express.raw({ type: "*/*", limit: "12mb" }), async (req, res) => {
  const { writeObject } = require("../storage");
  const { requireOwnedUpload, markUploaded, UploadError } = require("../services/uploadService");

  try {
    // Ownership, not just key shape. Previously any authenticated user
    // holding a quarantine key could write to it.
    const upload = await requireOwnedUpload(req.user.id, decodeURIComponent(req.params.key), {
      allowStatuses: ["pending"],
    });
    await writeObject(upload.storage_key, req.body);
    await markUploaded(upload.id);
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof UploadError) return res.status(e.status).json({ error: e.message, code: e.code });
    throw e;
  }
});

// Step 3: validate, strip EXIF, re-encode, and promote out of quarantine.
// Nothing uploaded this way is publicly reachable until this succeeds.
router.post("/finalize", requireAuth, express.json(), async (req, res) => {
  const { processUpload, ImageProcessingError } = require("../services/imageProcessingService");
  const {
    requireOwnedUpload, markProcessed, markFailed, UploadError,
  } = require("../services/uploadService");

  let upload;
  try {
    upload = await requireOwnedUpload(req.user.id, req.body?.key, {
      allowStatuses: ["pending", "uploaded"],
    });
  } catch (e) {
    if (e instanceof UploadError) return res.status(e.status).json({ error: e.message, code: e.code });
    throw e;
  }

  try {
    const result = await processUpload(upload.storage_key, { requestId: req.id, uploadId: upload.id });
    // When queued, the worker owns the uploaded -> processed/failed
    // transition (see worker.js) - the response returns before that
    // happens, so there's no result.key here yet to mark processed with.
    if (result.key) await markProcessed(upload.id, { publicKey: result.key, publicUrl: result.url, publicThumbUrl: result.thumbUrl });
    res.json(result);
  } catch (e) {
    if (e instanceof ImageProcessingError) {
      // Recording the failure means a rejected upload can't be retried
      // indefinitely against the same key, and leaves a trace of why.
      await markFailed(upload.id, e.message);
      return res.status(e.status).json({ error: e.message, code: e.code });
    }
    throw e;
  }
});

module.exports = router;
