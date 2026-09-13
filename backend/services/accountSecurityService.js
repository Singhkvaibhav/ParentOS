const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { query, withTransaction } = require("../db");
const { sendNotificationEmail } = require("../email");
const { revokeAllForUser, hashToken } = require("./tokenService");
const logger = require("../logger");
const i18n = require("../i18n");

class AccountSecurityError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const RESET_TOKEN_TTL_MINUTES = 30;
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MINUTES = 15;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

// --- Password reset -------------------------------------------------------

// Always reports success, whether or not the address exists.
//
// Telling an anonymous caller "no account with that email" turns this
// endpoint into an account-enumeration oracle - and for a marketplace where
// the accounts belong to parents, confirming that a specific person has an
// account here is itself a privacy leak, separate from any takeover risk.
async function requestPasswordReset(email, { ip } = {}) {
  const { rows } = await query("SELECT id, name, email, locale FROM users WHERE email = $1", [
    String(email || "").trim().toLowerCase(),
  ]);
  const user = rows[0];

  if (user) {
    // Any previously issued token becomes useless: a user who requests a
    // second link because the first didn't arrive shouldn't leave two live
    // takeover paths in their inbox.
    await query(
      "UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL",
      [user.id]
    );

    const raw = crypto.randomBytes(32).toString("hex");
    await query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip)
       VALUES ($1, $2, now() + ($3 || ' minutes')::interval, $4)`,
      [user.id, hashToken(raw), String(RESET_TOKEN_TTL_MINUTES), ip || null]
    );

    const link = `${FRONTEND_URL}/reset-password?token=${raw}`;
    await sendNotificationEmail(
      user.email,
      i18n.t(user.locale, "resetSubject"),
      i18n.t(user.locale, "resetText", { name: user.name, link, ttlMinutes: RESET_TOKEN_TTL_MINUTES })
    );

    logger.info("password_reset_requested", { userId: user.id, ip });
  } else {
    logger.info("password_reset_requested_unknown_email", { ip });
  }

  return { ok: true };
}

async function resetPassword(rawToken, newPassword) {
  if (!newPassword || String(newPassword).length < 8) {
    throw new AccountSecurityError(400, "Password must be at least 8 characters.");
  }

  const tokenHash = hashToken(String(rawToken || ""));
  let userId;

  await withTransaction(async (tx) => {
    // Claim the token by UPDATE ... RETURNING, not SELECT-then-check.
    //
    // The previous version read the token, checked used_at and expiry in
    // JavaScript, changed the password, and only then marked the token
    // used. Two concurrent requests with the same token both read it as
    // unused and both proceeded - so a "single-use" token was only
    // single-use when nobody raced it, which is exactly the condition an
    // attacker holding a leaked token would not respect.
    //
    // Moving the conditions into the WHERE clause makes the database the
    // arbiter: whichever statement runs first flips used_at, the second
    // matches zero rows, and only the request holding the returned row
    // continues.
    const { rows } = await tx(
      `UPDATE password_reset_tokens
       SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING *`,
      [tokenHash]
    );
    const token = rows[0];

    // One message for every failure mode - expired, already used, and
    // nonexistent are indistinguishable to the caller, so a guessed token
    // reveals nothing about whether it was ever real.
    if (!token) throw new AccountSecurityError(400, "That reset link is invalid or has expired.");

    userId = token.user_id;
    const passwordHash = await bcrypt.hash(String(newPassword), 10);

    // In the SAME transaction as the claim. If the password update failed
    // after the claim committed separately, the user would be left with a
    // burned token and an unchanged password - locked out by the very
    // mechanism meant to let them back in.
    await tx(
      // Bumping session_version invalidates existing access tokens, and
      // clearing the lockout lets a user who reset BECAUSE they were
      // locked out actually get back in.
      `UPDATE users
       SET password_hash = $1, session_version = session_version + 1,
           failed_login_count = 0, locked_until = NULL
       WHERE id = $2`,
      [passwordHash, token.user_id]
    );

    // Any OTHER outstanding reset token is burned too. Otherwise a second
    // link sitting in the inbox stays a live takeover path after the
    // password has already been changed.
    await tx(
      "UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL",
      [token.user_id]
    );
  });

  // Session revocation runs after the transaction commits. Refresh tokens
  // are a separate concern from the password change, and a failure here
  // must not roll back a password the user has already been told to expect
  // - the same reasoning as the refresh-token reuse fix.
  await revokeAllForUser(userId, "password_reset");

  const { rows: userRows } = await query("SELECT email, name, locale FROM users WHERE id = $1", [userId]);
  if (userRows[0]) {
    // Notifying after the fact is what lets a victim notice a takeover
    // they didn't initiate.
    await sendNotificationEmail(
      userRows[0].email,
      i18n.t(userRows[0].locale, "passwordChangedSubject"),
      i18n.t(userRows[0].locale, "passwordChangedText", { name: userRows[0].name })
    );
  }

  logger.warn("password_reset_completed", { userId });
  return { ok: true };
}

// --- Lockout --------------------------------------------------------------

// Per-account throttling, which per-IP rate limiting can't provide: an
// attacker rotating IPs would otherwise get unlimited guesses at one
// account, and a shared office IP would punish innocent colleagues.
async function assertNotLocked(user) {
  if (user?.locked_until && new Date(user.locked_until) > new Date()) {
    const minutes = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000);
    throw new AccountSecurityError(429, `Too many failed attempts. Try again in ${minutes} minute(s).`);
  }
}

async function recordFailedLogin(user) {
  if (!user) return;
  // Single statement so concurrent attempts can't all read the same stale
  // count and slip past the threshold together.
  await query(
    `UPDATE users
     SET failed_login_count = failed_login_count + 1,
         locked_until = CASE
           WHEN failed_login_count + 1 >= $2 THEN now() + ($3 || ' minutes')::interval
           ELSE locked_until END
     WHERE id = $1`,
    [user.id, MAX_FAILED_LOGINS, String(LOCKOUT_MINUTES)]
  );
}

async function clearFailedLogins(userId) {
  await query(
    "UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1 AND failed_login_count > 0",
    [userId]
  );
}

// --- Login history and suspicious-login detection -------------------------

// "Suspicious" here means: this account has signed in successfully before,
// and never from this IP. Deliberately coarse - it's a prompt to tell the
// user, not an authorization decision, so a false positive costs an email
// rather than a lockout.
async function isSuspiciousLogin(userId, ip) {
  const { rows } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE outcome = 'success') AS successes,
       COUNT(*) FILTER (WHERE outcome = 'success' AND ip = $2) AS from_this_ip
     FROM login_events WHERE user_id = $1`,
    [userId, ip || null]
  );
  const { successes, from_this_ip: fromThisIp } = rows[0];
  return Number(successes) > 0 && Number(fromThisIp) === 0;
}

async function recordLogin({ userId = null, email, outcome, ip, userAgent, suspicious = false }) {
  await query(
    `INSERT INTO login_events (user_id, email_attempted, outcome, ip, user_agent, suspicious)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, email || null, outcome, ip || null, userAgent?.slice(0, 500) || null, suspicious]
  );
}

async function notifySuspiciousLogin(user, { ip, userAgent }) {
  await sendNotificationEmail(
    user.email,
    i18n.t(user.locale, "suspiciousLoginSubject"),
    i18n.t(user.locale, "suspiciousLoginText", { name: user.name, ip, userAgent })
  );
  logger.warn("suspicious_login_notified", { userId: user.id, ip });
}

async function loginHistory(userId, limit = 20) {
  const { rows } = await query(
    `SELECT outcome, ip, user_agent, suspicious, created_at
     FROM login_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.min(Number(limit) || 20, 100)]
  );
  return rows;
}

module.exports = {
  AccountSecurityError,
  requestPasswordReset,
  resetPassword,
  assertNotLocked,
  recordFailedLogin,
  clearFailedLogins,
  isSuspiciousLogin,
  recordLogin,
  notifySuspiciousLogin,
  loginHistory,
  MAX_FAILED_LOGINS,
  LOCKOUT_MINUTES,
  RESET_TOKEN_TTL_MINUTES,
};
