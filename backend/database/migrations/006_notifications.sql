-- P2 #18: notifications.
--
-- Until now the only way to learn that someone messaged you, bought your
-- item, or left you a review was to happen to open the app. For a
-- marketplace where the other party is waiting on a reply, that's the
-- difference between a sale and a dead thread.
--
-- Notifications are stored rather than only emailed, for two reasons: the
-- in-app list works without any email provider configured, and a stored
-- row gives idempotency (an event can't produce two notifications) plus a
-- record of what was actually sent.

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'message_received',
    'item_sold',
    'purchase_confirmed',
    'review_received',
    'listing_taken_down'
  )),

  -- Loose references: a notification about a deleted listing should
  -- degrade to plain text rather than vanish or block the delete, so
  -- these are nullable with ON DELETE SET NULL rather than cascading.
  listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,

  -- Rendered at write time. Denormalized deliberately: a notification is a
  -- record of what the user was told at that moment, so it shouldn't
  -- silently change later if the listing is renamed.
  title TEXT NOT NULL,
  body TEXT,

  read_at TIMESTAMPTZ,
  emailed_at TIMESTAMPTZ,  -- NULL means never emailed (email off, or send failed)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The common query is "my unread notifications, newest first".
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_user
  ON notifications(user_id, created_at DESC);

-- Per-user email preferences. Defaults to on for the things someone is
-- actively waiting on (a message, a sale) - but a user who doesn't want
-- email must be able to turn it off, and "notify me about everything by
-- default forever" is how products end up in spam folders.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_notifications BOOLEAN NOT NULL DEFAULT true;
