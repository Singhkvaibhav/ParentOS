-- P2 #20: reporting, blocking, and moderation.
--
-- A marketplace for children's items needs a way for people to flag
-- unsafe listings (recalled car seats, damaged cots) and abusive users,
-- and a way to stop someone from contacting them. Without this the only
-- recourse is emailing support, which doesn't scale and leaves no record.

-- Admin flag. Deliberately a plain boolean rather than a roles table -
-- there's exactly one privileged capability right now (moderation), and
-- inventing a role system before there's a second one is speculative.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- Exactly one target: a listing OR a user OR a conversation. A CHECK
  -- enforces that rather than trusting application code, so a malformed
  -- report can't be stored at all.
  listing_id INTEGER REFERENCES listings(id) ON DELETE CASCADE,
  reported_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,

  reason TEXT NOT NULL CHECK (reason IN (
    'safety',        -- recalled/unsafe item, damaged in a dangerous way
    'prohibited',    -- item that shouldn't be sold here at all
    'misleading',    -- description doesn't match the item
    'harassment',    -- abusive messages or behaviour
    'spam',
    'other'
  )),
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'actioned', 'dismissed')),
  moderator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  moderator_note TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT reports_exactly_one_target CHECK (
    (listing_id IS NOT NULL)::int +
    (reported_user_id IS NOT NULL)::int +
    (conversation_id IS NOT NULL)::int = 1
  ),
  -- Can't report yourself - catches a UI bug rather than real abuse, but
  -- it's a nonsense row either way.
  CONSTRAINT reports_not_self CHECK (reported_user_id IS NULL OR reported_user_id <> reporter_id)
);

-- One open report per person per target: re-reporting the same listing
-- shouldn't flood the moderation queue with duplicates, but a NEW report
-- after an earlier one was resolved is legitimate (the problem recurred).
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_one_open_per_listing
  ON reports(reporter_id, listing_id) WHERE status IN ('open', 'reviewing') AND listing_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_one_open_per_user
  ON reports(reporter_id, reported_user_id) WHERE status IN ('open', 'reviewing') AND reported_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_one_open_per_conversation
  ON reports(reporter_id, conversation_id) WHERE status IN ('open', 'reviewing') AND conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);

-- Blocking is separate from reporting: reporting asks moderators to act,
-- blocking is something a user does for themselves immediately without
-- waiting for anyone.
CREATE TABLE IF NOT EXISTS blocks (
  id SERIAL PRIMARY KEY,
  blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(blocker_id, blocked_id),
  CONSTRAINT blocks_not_self CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON blocks(blocker_id);

-- Moderators can take a listing down. Kept separate from the seller's own
-- status values ('active'/'reserved'/'sold') so a seller can't relist
-- their way out of a moderation decision - see listingsService.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS moderation_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_listings_moderated ON listings(moderated_at) WHERE moderated_at IS NOT NULL;
