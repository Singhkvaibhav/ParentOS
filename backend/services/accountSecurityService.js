const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { query } = require("../db");
const { sendNotificationEmail } = require("../email");
const { revokeAllForUser, hashToken } = require("./tokenService");
const logger = require("../logger");

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
  const { rows } = await query("SELECT id, name, email FROM users WHERE email = $1", [
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
      "Reset your Uusiksi password",
      `Hi ${user.name},\n\nSomeone asked to reset your password. This link works once and expires in ${RESET_TOKEN_TTL_MINUTES} minutes:\n\n${link}\n\nIf this wasn't you, you can ignore this email - your password hasn't changed.\n\n- Uusiksi`
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

  const { rows } = await query(
    "SELECT * FROM password_reset_tokens WHERE token_hash = $1",
    [hashToken(String(rawToken || ""))]
  );
  const token = rows[0];

  // One message for every failure mode - expired, used, and nonexistent are
  // indistinguishable to the caller, so a guessed token reveals nothing.
  if (!token || token.used_at || new Date(token.expires_at) < new Date()) {
    throw new AccountSecurityError(400, "That reset link is invalid or has expired.");
  }

  const passwordHash = await bcrypt.hash(String(newPassword), 10);

  await query("UPDATE password_reset_tokens SET used_at = now() WHERE id = $1", [token.id]);
  await query(
    // Bumping session_version invalidates existing access tokens, and
    // clearing the lockout lets a user who reset BECAUSE they were locked
    // out actually get back in.
    `UPDATE users
     SET password_hash = $1, session_version = session_version + 1,
         failed_login_count = 0, locked_until = NULL
     WHERE id = $2`,
    [passwordHash, token.user_id]
  );

  // Resetting a password must end every other session. If the reset was
  // prompted by a compromise, leaving the attacker's session alive would
  // defeat the entire exercise.
  await revokeAllForUser(token.user_id, "password_reset");

  const { rows: userRows } = await query("SELECT email, name FROM users WHERE id = $1", [token.user_id]);
  if (userRows[0]) {
    // Notifying after the fact is what lets a victim notice a takeover they
    // didn't initiate.
    await sendNotificationEmail(
      userRows[0].email,
      "Your Uusiksi password was changed",
      `Hi ${userRows[0].name},\n\nYour password was just changed and all other devices were signed out.\n\nIf this wasn't you, reset your password immediately and contact us.\n\n- Uusiksi`
    );
  }

  logger.warn("password_reset_completed", { userId: token.user_id });
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
    "New sign-in to your Uusiksi account",
    `Hi ${user.name},\n\nYour account was just signed in to from a device or location we haven't seen before.\n\nIP: ${ip || "unknown"}\nDevice: ${userAgent || "unknown"}\n\nIf this was you, nothing to do. If not, reset your password and sign out all devices from your profile.\n\n- Uusiksi`
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
