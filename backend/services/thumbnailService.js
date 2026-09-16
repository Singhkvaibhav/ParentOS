const sharp = require("sharp");

// Shared by both upload paths (images/routes.js's inline route and
// imageProcessingService.js's presigned-upload finalize step) so a listing
// grid - which renders many photos at once - never has to download and
// downscale the same full-size (1280-1600px) image dozens of times over.
// A dedicated small size beats the browser scaling an <img> down: the
// bytes transferred are what actually matter for a phone on mobile data.
const THUMB_MAX_DIMENSION = 400;
const THUMB_JPEG_QUALITY = 75;

// Resizes from the ORIGINAL bytes, not from the already-processed full-size
// JPEG - re-compressing a JPEG that's already been through lossy encoding
// once compounds artifacts for no benefit, and sharp has the original
// buffer in hand at both call sites anyway.
async function makeThumbnail(originalBuffer) {
  return sharp(originalBuffer)
    .resize({ width: THUMB_MAX_DIMENSION, height: THUMB_MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: THUMB_JPEG_QUALITY })
    .toBuffer();
}

module.exports = { makeThumbnail, THUMB_MAX_DIMENSION, THUMB_JPEG_QUALITY };
