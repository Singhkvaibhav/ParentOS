-- Auth hardening: short-lived access tokens with rotating refresh tokens,
-- password reset, and login history.
--
-- Today a single 30-day JWT in a cookie IS the session. That means a token
-- captured at any point stays usable for up to a month, and the only
-- defence is bumping session_version, which logs the user out of
-- everything at once. There is no way to revoke one device, and no way for
-- the user to see that a stolen token is being used.
--
-- Splitting the credential fixes both: a short access token limits the
-- window a leaked one is useful for, and a refresh token that ROTATES on
-- every use makes reuse detectable - if an old refresh token is presented
-- again, either the user or an attacker replayed it, and the whole family
-- can be revoked.

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- The token is stored hashed, never in plaintext. A database leak
  -- shouldn't hand an attacker working sessions - the same reason
  -- passwords are hashed.
  token_hash TEXT NOT NULL UNIQUE,

  -- Rotation chain. Every refresh issues a new token and marks the old one
  -- used; both point at the same family, so detecting replay of ANY member
  -- lets us revoke the entire chain rather than just the one token.
  family_id UUID NOT NULL,
  replaced_by_id BIGINT REFERENCES refresh_tokens(id) ON DELETE SET NULL,

  -- Context for suspicious-login detection and for showing the user their
  -- own sessions. Deliberately coarse: a user agent string and IP, not
  -- fingerprinting.
  user_agent TEXT,
  ip TEXT,

  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expiry ON refresh_tokens(expires_at);

-- Password reset tokens. Single-use and short-lived: a reset link sitting
-- in an inbox is a standing takeover risk for as long as it stays valid.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  requested_ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id, used_at);

-- Login history. Needed to answer "was that you?" - both for the user's own
-- session list and to notice a login from somewhere the account has never
-- been used from.
CREATE TABLE IF NOT EXISTS login_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  -- Recorded even for failures, so repeated attempts against one account
  -- are visible. Nullable user_id covers attempts on addresses that don't
  -- exist.
  email_attempted TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'bad_password', 'unknown_email', 'locked')),
  ip TEXT,
  user_agent TEXT,
  suspicious BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_events_email ON login_events(email_attempted, created_at DESC);

-- Account lockout after repeated failures, so password guessing is
-- throttled per-account rather than only per-IP (an attacker rotating IPs
-- would otherwise be unlimited).
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

-- Tombstone marker. The user row survives account deletion because
-- transactions reference it and those must be retained, so there has to be
-- a way to tell "anonymized former user" from "active account" - login,
-- listing creation and messaging all check it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_users_deleted ON users(deleted_at) WHERE deleted_at IS NOT NULL;
