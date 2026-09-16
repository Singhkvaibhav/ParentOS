const { query } = require("../db");
const { createPresignedUpload, QUARANTINE_PREFIX } = require("../storage");
const logger = require("../logger");

class UploadError extends Error {
  constructor(status, message, code = null, meta = null) {
    super(message);
    this.status = status;
    this.code = code;
    if (meta) this.meta = meta;
  }
}

// Ownership for direct uploads.
//
// The presigned key used to be the only credential: any authenticated user
// presenting a `quarantine/...` key could write to it or finalize it. That
// treated unguessability as authorization, which it isn't - keys leak
// through logs, browser history, proxies and error reports, and the moment
// one does, "hard to guess" stops being any protection at all.
//
// Now every key is issued against a row naming the user it belongs to, and
// both later steps check it.

async function createUpload(userId, { contentType = "image/jpeg" } = {}) {
  if (!/^image\//.test(String(contentType))) {
    throw new UploadError(400, "Only images can be uploaded.", "onlyImages");
  }

  const presigned = await createPresignedUpload({ contentType });

  await query(
    `INSERT INTO uploads (user_id, storage_key, content_type) VALUES ($1, $2, $3)`,
    [userId, presigned.key, contentType]
  );

  return presigned;
}

// Loads an upload and asserts it belongs to the caller.
//
// A key belonging to someone else returns 404, not 403: telling an
// attacker "that key exists but isn't yours" confirms the key is real,
// which is exactly the information they'd be probing for.
async function requireOwnedUpload(userId, storageKey, { allowStatuses } = {}) {
  const key = String(storageKey || "");

  // Kept as a cheap structural guard even though ownership is now the real
  // check - it stops a malformed key reaching the storage layer at all.
  if (!key.startsWith(QUARANTINE_PREFIX)) {
    throw new UploadError(400, "Invalid upload key.", "invalidUploadKey");
  }

  const { rows } = await query("SELECT * FROM uploads WHERE storage_key = $1", [key]);
  const upload = rows[0];

  if (!upload || upload.user_id !== userId) {
    if (upload) {
      // Worth logging: a user presenting someone else's key is either a
      // bug in the client or someone probing, and both are worth seeing.
      logger.warn("upload_key_ownership_mismatch", {
        storageKey: key, ownerId: upload.user_id, attemptedBy: userId,
      });
    }
    throw new UploadError(404, "Upload not found.", "uploadNotFound");
  }

  if (new Date(upload.expires_at) < new Date() && upload.status === "pending") {
    throw new UploadError(410, "This upload expired - request a new upload URL.", "uploadExpired");
  }

  if (allowStatuses && !allowStatuses.includes(upload.status)) {
    throw new UploadError(409, `This upload is already ${upload.status}.`);
  }

  return upload;
}

async function markUploaded(uploadId) {
  await query("UPDATE uploads SET status = 'uploaded' WHERE id = $1 AND status = 'pending'", [uploadId]);
}

async function markProcessed(uploadId, { publicKey, publicUrl, publicThumbUrl }) {
  await query(
    `UPDATE uploads SET status = 'processed', public_key = $1, public_url = $2, public_thumb_url = $3, completed_at = now()
     WHERE id = $4`,
    [publicKey, publicUrl, publicThumbUrl || null, uploadId]
  );
}

async function markFailed(uploadId, message) {
  await query(
    "UPDATE uploads SET status = 'failed', error = $1, completed_at = now() WHERE id = $2",
    [String(message).slice(0, 500), uploadId]
  );
}

// Abandoned uploads: presigned but never completed. Previously these left
// orphaned objects with nothing recording they existed, so they could
// never be found again to clean up.
async function sweepAbandoned() {
  const { deleteImage } = require("../storage");
  const { rows } = await query(
    `SELECT id, storage_key FROM uploads
     WHERE status IN ('pending', 'uploaded') AND expires_at < now()
     LIMIT 200`
  );

  for (const upload of rows) {
    // Best-effort: the object may never have been written at all, which is
    // the common case for an abandoned presign.
    await deleteImage(upload.storage_key).catch(() => {});
    await query("UPDATE uploads SET status = 'failed', error = 'abandoned', completed_at = now() WHERE id = $1", [upload.id]);
  }

  if (rows.length > 0) logger.info("abandoned_uploads_swept", { count: rows.length });
  return { swept: rows.length };
}

module.exports = {
  UploadError,
  createUpload,
  requireOwnedUpload,
  markUploaded,
  markProcessed,
  markFailed,
  sweepAbandoned,
};
