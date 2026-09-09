// Business logic for signup/verify/login - no Express req/res here, just
// data and errors, so this is testable and reusable independent of HTTP.
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { query } = require("../db");
const { sendVerificationEmail } = require("../email");

const CODE_TTL_MS = 15 * 60 * 1000; // verification codes expire after 15 minutes
const MAX_VERIFY_ATTEMPTS = 5;
// Used to keep bcrypt.compare's timing roughly constant when no account
// exists, so a nonexistent email doesn't respond measurably faster than a
// wrong password does.
const DUMMY_HASH = "$2a$10$CwTycUXWue0Thq9StjUM0uJ8kQxbG3Kv9OYIEV6c3v6qDlqfPTIYK";

class AuthError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

// crypto.randomInt is cryptographically secure, unlike Math.random() - worth
// the difference for anything that gates account access, even a short-lived
// 6-digit code where the real brute-force defense is the attempt lockout
// below, not the code's own unpredictability.
function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}

// The code is hashed the same way passwords are (bcrypt, same as
// password_hash) before it's stored - only the plaintext version that gets
// emailed (or returned as devCode) is ever in the clear. This protects
// against a database read (backup leak, compromised admin panel, etc.)
// handing over everyone's live verification codes directly; the 5-attempt
// lockout in verify() is what defends against guessing, this is what
// defends against the DB itself being read.
async function hashCode(code) {
  return bcrypt.hash(code, 10);
}

function signToken(user) {
  // `sub` (subject) is the standard JWT claim for "who this token is about" -
  // using it means the token identifies the user by their immutable id, not
  // by email (which can change and shouldn't be an identity key anyway).
  //
  // `sv` (session version) is what makes these otherwise-stateless tokens
  // revocable: requireAuth re-checks it against the user's current
  // session_version on every request, so bumping that column instantly
  // invalidates every token issued before the bump - for that one user,
  // without touching anyone else's sessions.
  return jwt.sign(
    { sub: user.id, sv: user.session_version, email: user.email, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );
}

function publicUser(user) {
  // isAdmin drives whether the UI offers a moderation link. It's not an
  // authorization mechanism - every moderation endpoint checks admin
  // status server-side regardless of what the client believes.
  return { id: user.id, name: user.name, email: user.email, verified: !!user.verified, isAdmin: !!user.is_admin };
}

async function signup({ name, email, password }) {
  if (!name?.trim() || !email?.trim() || !password || password.length < 6) {
    throw new AuthError(400, "Name, email and a password (6+ characters) are required.");
  }
  const normalizedEmail = email.trim().toLowerCase();
  const existing = await query("SELECT id FROM users WHERE email = $1", [normalizedEmail]);
  if (existing.rows.length > 0) throw new AuthError(409, "An account with that email already exists.");

  const passwordHash = await bcrypt.hash(password, 10);
  const code = generateCode();
  const codeHash = await hashCode(code);
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await query(
    `INSERT INTO users (name, email, password_hash, verified, verification_code, verification_expires_at, verification_attempts)
     VALUES ($1, $2, $3, false, $4, $5, 0)`,
    [name.trim(), normalizedEmail, passwordHash, codeHash, expiresAt]
  );

  const emailResult = await sendVerificationEmail(normalizedEmail, name.trim(), code);
  const devCode = process.env.NODE_ENV !== "production" ? code : null;
  return {
    message: emailResult.sent
      ? "Account created — check your email for a verification code."
      : emailResult.reason === "send-failed"
        ? "Account created, but we couldn't send the verification email right now — try \"resend code\" in a moment."
        : "Account created — verify your email to continue.",
    // A genuine send failure (not the intentional dev-fallback) is worth
    // the frontend showing explicitly, especially in production where
    // there's no devCode to fall back on and the user would otherwise have
    // no way to know anything went wrong.
    warning: emailResult.reason === "send-failed" ? "email-send-failed" : null,
    devCode,
  };
}

async function resendCode({ email }) {
  const { rows } = await query("SELECT * FROM users WHERE email = $1", [(email || "").toLowerCase()]);
  const user = rows[0];
  if (!user) throw new AuthError(404, "No account with that email.");
  if (user.verified) throw new AuthError(400, "Already verified — log in instead.");

  const code = generateCode();
  const codeHash = await hashCode(code);
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await query(
    "UPDATE users SET verification_code = $1, verification_expires_at = $2, verification_attempts = 0 WHERE id = $3",
    [codeHash, expiresAt, user.id]
  );

  const emailResult = await sendVerificationEmail(user.email, user.name, code);
  const devCode = process.env.NODE_ENV !== "production" ? code : null;
  return {
    message: emailResult.sent
      ? "A new code has been emailed to you."
      : emailResult.reason === "send-failed"
        ? "We couldn't send the email right now - please try again shortly."
        : "A new code has been issued.",
    warning: emailResult.reason === "send-failed" ? "email-send-failed" : null,
    devCode,
  };
}

async function verify({ email, code }) {
  const { rows } = await query("SELECT * FROM users WHERE email = $1", [(email || "").toLowerCase()]);
  const user = rows[0];
  if (!user) throw new AuthError(404, "No account with that email.");
  if (user.verified) throw new AuthError(400, "Already verified — log in instead.");

  // (P1 #4) Atomically claim an attempt BEFORE checking the code. The
  // previous read-then-write let concurrent guesses all pass the limit
  // check against the same stale count - firing 100 requests at once,
  // every one of them would see "attempts = 0" and proceed, making the
  // 5-attempt lockout meaningless against exactly the automated attacker
  // it exists to stop.
  //
  // Incrementing conditionally in a single statement means the database
  // serializes the attempts: only the first MAX_VERIFY_ATTEMPTS updates
  // match, and the rest are locked out.
  const claim = await query(
    `UPDATE users SET verification_attempts = verification_attempts + 1
     WHERE id = $1 AND verification_attempts < $2`,
    [user.id, MAX_VERIFY_ATTEMPTS]
  );
  if (claim.rowCount === 0) {
    throw new AuthError(429, "Too many attempts — request a new code.", { locked: true });
  }
  if (!user.verification_expires_at || new Date(user.verification_expires_at) < new Date()) {
    throw new AuthError(400, "That code has expired — request a new one.", { expired: true });
  }
  if (!(await bcrypt.compare(String(code).trim(), user.verification_code || ""))) {
    // The attempt was already counted by the atomic claim above - counting
    // it again here would halve the real allowance.
    const { rows: attemptRows } = await query("SELECT verification_attempts FROM users WHERE id = $1", [user.id]);
    const remaining = MAX_VERIFY_ATTEMPTS - Number(attemptRows[0]?.verification_attempts ?? MAX_VERIFY_ATTEMPTS);
    throw new AuthError(400, "That code doesn't match.", { attemptsRemaining: Math.max(remaining, 0) });
  }

  await query(
    "UPDATE users SET verified = true, verification_code = NULL, verification_expires_at = NULL, verification_attempts = 0 WHERE id = $1",
    [user.id]
  );
  const { rows: updatedRows } = await query("SELECT * FROM users WHERE id = $1", [user.id]);
  const updated = updatedRows[0];
  return { token: signToken(updated), user: publicUser(updated) };
}

async function login({ email, password }, context = {}) {
  const {
    assertNotLocked, recordFailedLogin, clearFailedLogins,
    recordLogin, isSuspiciousLogin, notifySuspiciousLogin, AccountSecurityError,
  } = require("./accountSecurityService");

  const normalizedEmail = (email || "").toLowerCase();
  const { rows } = await query("SELECT * FROM users WHERE email = $1", [normalizedEmail]);
  const user = rows[0];

  // Per-account lockout, checked before the password comparison. Per-IP
  // rate limiting can't cover this: an attacker rotating IPs would
  // otherwise get unlimited guesses against a single account.
  try {
    await assertNotLocked(user);
  } catch (e) {
    if (e instanceof AccountSecurityError) {
      await recordLogin({ userId: user?.id, email: normalizedEmail, outcome: "locked", ...context });
      throw new AuthError(e.status, e.message);
    }
    throw e;
  }

  // Compared against a dummy hash for unknown addresses so the response
  // time doesn't reveal whether the account exists.
  const ok = await bcrypt.compare(password || "", user ? user.password_hash : DUMMY_HASH);

  // A deleted account's row survives (transactions reference it) with an
  // empty password hash, so it can never match - but the check is explicit
  // rather than relying on that.
  if (!user || !ok || user.deleted_at) {
    if (user) await recordFailedLogin(user);
    await recordLogin({
      userId: user?.id, email: normalizedEmail,
      outcome: user ? "bad_password" : "unknown_email", ...context,
    });
    throw new AuthError(401, "Invalid email or password.");
  }

  if (!user.verified) throw new AuthError(403, "Verify your email first.", { needsVerification: true });

  const suspicious = await isSuspiciousLogin(user.id, context.ip);
  await clearFailedLogins(user.id);
  await recordLogin({ userId: user.id, email: normalizedEmail, outcome: "success", suspicious, ...context });

  if (suspicious) {
    // Fire-and-forget: a sign-in must not fail because a warning email
    // couldn't be sent.
    notifySuspiciousLogin(user, context).catch(() => {});
  }

  return { token: signToken(user), user: publicUser(user), suspicious };
}

// Invalidates every token currently issued to this user (including the
// one making this request) by bumping their session_version - see
// signToken and middleware/requireAuth. This is the "log out on all
// devices" action, and the remedy if a session is ever suspected stolen.
// Returns a fresh token so the *current* device can stay signed in, which
// is how this normally behaves elsewhere - the point is to evict the
// other sessions, not to lock the user out of the one they're using.
async function logoutEverywhere(userId) {
  const { rows } = await query(
    "UPDATE users SET session_version = session_version + 1 WHERE id = $1 RETURNING *",
    [userId]
  );
  const user = rows[0];
  if (!user) throw new AuthError(404, "User not found.");
  return { token: signToken(user), user: publicUser(user) };
}

async function getById(id) {
  const { rows } = await query("SELECT * FROM users WHERE id = $1", [id]);
  if (!rows[0]) throw new AuthError(404, "User not found.");
  return publicUser(rows[0]);
}

module.exports = { AuthError, signup, resendCode, verify, login, logoutEverywhere, getById };
