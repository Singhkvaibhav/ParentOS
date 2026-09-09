const express = require("express");
const sharp = require("sharp");
const logger = require("../logger");
const requireAuth = require("../middleware/requireAuth");
const { saveBuffer, parseDataUrl } = require("../storage");

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
    res.status(201).json({ url });
  } catch (e) {
    logger.error("image_upload_failed", { requestId: req.id, err: e });
    res.status(500).json({ error: "Could not store that image." });
  }
});

// --- Direct (presigned) upload flow --------------------------------------
//
// Three steps: ask for a URL, PUT the bytes straight to storage, then tell
// the backend to process what landed. The middle step never touches this
// server when S3 is configured.

// Step 1: hand the browser a short-lived upload URL.
router.post("/presign", express.json(), requireAuth, async (req, res) => {
  const { createPresignedUpload } = require("../storage");
  const contentType = String(req.body?.contentType || "image/jpeg");
  if (!/^image\//.test(contentType)) {
    return res.status(400).json({ error: "Only images can be uploaded." });
  }
  res.json(await createPresignedUpload({ contentType }));
});

// Step 2 (local driver only): stands in for the object store so the
// browser flow is identical in development. With S3 configured the
// browser PUTs to Amazon/R2 and never reaches this route.
router.put("/direct/:key", requireAuth, express.raw({ type: "*/*", limit: "12mb" }), async (req, res) => {
  const { writeObject, QUARANTINE_PREFIX } = require("../storage");
  const key = decodeURIComponent(req.params.key);
  // The key came from us, but it arrives via the client - so re-check it
  // targets quarantine rather than trusting it to overwrite a public object.
  if (!key.startsWith(QUARANTINE_PREFIX)) {
    return res.status(400).json({ error: "Invalid upload target." });
  }
  await writeObject(key, req.body);
  res.json({ ok: true });
});

// Step 3: validate, strip EXIF, re-encode, and promote out of quarantine.
// Nothing uploaded this way is publicly reachable until this succeeds.
router.post("/finalize", requireAuth, express.json(), async (req, res) => {
  const { processUpload } = require("../services/imageProcessingService");
  const { ImageProcessingError } = require("../services/imageProcessingService");
  const { QUARANTINE_PREFIX } = require("../storage");
  const key = String(req.body?.key || "");
  if (!key.startsWith(QUARANTINE_PREFIX)) {
    return res.status(400).json({ error: "Invalid upload key." });
  }

  try {
    const result = await processUpload(key, { requestId: req.id });
    res.json(result);
  } catch (e) {
    if (e instanceof ImageProcessingError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

module.exports = router;
