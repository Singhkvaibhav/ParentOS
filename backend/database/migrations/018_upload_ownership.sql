-- Ties every direct upload to the user who requested it.
--
-- The presign flow generated a key like `quarantine/<uuid>.upload` and the
-- PUT and finalize endpoints checked only that the key started with
-- `quarantine/`. Nothing recorded WHO the key was issued to, so any
-- authenticated user who obtained a key could write to it or finalize it.
--
-- A UUID is unguessable, but unguessable is not the same as authorized -
-- keys travel through logs, browser history, proxies and error reports,
-- and any of those turns "hard to guess" into "known". Authorization has
-- to be checked, not inferred from entropy.
--
-- This also gives abandoned uploads somewhere to be found: previously a
-- presigned key that was never used left an orphaned object with nothing
-- recording that it existed.
CREATE TABLE IF NOT EXISTS uploads (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- The quarantine key handed to the browser.
  storage_key TEXT NOT NULL UNIQUE,
  content_type TEXT,

  -- pending    - presigned, nothing uploaded yet (or upload not confirmed)
  -- uploaded   - bytes received, awaiting processing
  -- processed  - validated, stripped and promoted to the public prefix
  -- failed     - rejected during processing (not an image, too large)
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'uploaded', 'processed', 'failed')),

  -- Where it ended up once promoted.
  public_key TEXT,
  public_url TEXT,
  error TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A presigned URL is short-lived; the record it refers to should be too.
  -- Anything still pending past this is abandoned and can be swept.
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 hour',
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_abandoned
  ON uploads(expires_at) WHERE status IN ('pending', 'uploaded');
