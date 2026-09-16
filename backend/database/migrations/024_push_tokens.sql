-- Push notification device tokens.
--
-- The existing notification system (migration 006) has two channels
-- already - an in-app list and email - both driven from the single
-- notify()/create() entry point in notificationsService.js. Push is a
-- third channel wired into that same function, not a parallel system: a
-- message, a sale, a review already trigger a notify() call everywhere in
-- the codebase, so adding push there means every existing trigger point
-- gets it for free.
--
-- Consent for push is implicit in whether a token is registered at all -
-- getting one requires the OS-level permission prompt on the device, so
-- there's no separate "push_notifications" boolean the way email has one.
-- A user with no rows here simply gets no push, the same as if they'd
-- never granted permission.
CREATE TABLE IF NOT EXISTS push_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- One row per physical device, not per user - the same phone can end up
  -- registered to a different account after a sign-out/sign-in, which the
  -- upsert in pushService.js handles by reassigning this row rather than
  -- erroring on the uniqueness constraint.
  token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Bumped on every re-registration (e.g. app relaunch) - not currently
  -- swept on staleness, but this is what a future "prune tokens unused for
  -- N months" job would key off rather than only reacting to Expo's
  -- DeviceNotRegistered error after the fact.
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens(user_id);
