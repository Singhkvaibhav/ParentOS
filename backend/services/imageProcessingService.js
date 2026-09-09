const sharp = require("sharp");
const {
  readObject, writeObject, deleteImage,
  PUBLIC_PREFIX,
} = require("../storage");
const { isEnabled: queuesEnabled, enqueue, QUEUE_NAMES } = require("../queue");
const logger = require("../logger");

// (#13) Processes a directly-uploaded image out of quarantine.
//
// This is the step that makes direct upload safe. The inline upload route
// re-encodes with sharp, which rejects non-images and strips embedded
// metadata. A presigned upload skips all of that, so it has to happen here
// before the object is reachable.
//
// EXIF stripping is the part that matters most: a phone photo of a cot
// taken in someone's living room carries GPS coordinates of their home.
// Publishing that alongside "children's items, collect from this address"
// would be a serious privacy failure.
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 82;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

class ImageProcessingError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function processQuarantinedImage(quarantineKey) {
  const raw = await readObject(quarantineKey);

  let processed;
  try {
    // Re-encoding is what strips EXIF (including GPS) - sharp does not
    // carry metadata across unless explicitly asked to with withMetadata().
    processed = await sharp(raw)
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
  } catch {
    // Not a real image. Remove it rather than leaving unvalidated bytes
    // sitting in the bucket.
    await deleteImage(quarantineKey).catch(() => {});
    throw new ImageProcessingError(400, "That doesn't look like a valid image.");
  }

  if (processed.length > MAX_OUTPUT_BYTES) {
    await deleteImage(quarantineKey).catch(() => {});
    throw new ImageProcessingError(400, "Image is still too large after resizing.");
  }

  const publicKey = `${PUBLIC_PREFIX}${quarantineKey.split("/").pop().replace(/\.[^.]+$/, "")}.jpg`;
  const url = await writeObject(publicKey, processed);

  // The quarantine copy still holds the original EXIF, so it must not be
  // left behind.
  await deleteImage(quarantineKey).catch((e) =>
    logger.warn("quarantine_cleanup_failed", { quarantineKey, err: e })
  );

  logger.info("image_processed", { quarantineKey, publicKey, bytes: processed.length });
  return { url, key: publicKey };
}

// Called from the request path. Prefers the queue so a slow image doesn't
// hold the response open, but processes inline when there's no queue -
// returning an unprocessed image would mean serving un-stripped EXIF,
// which is never an acceptable fallback.
async function processUpload(quarantineKey, { requestId } = {}) {
  if (queuesEnabled()) {
    const queued = await enqueue(QUEUE_NAMES.IMAGE_PROCESSING, "process", { quarantineKey, requestId });
    if (queued) return { queued: true };
    logger.warn("image_processing_queue_unavailable_running_inline", { quarantineKey });
  }
  return { queued: false, ...(await processQuarantinedImage(quarantineKey)) };
}

module.exports = { ImageProcessingError, processQuarantinedImage, processUpload };
