const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { query, withTransaction } = require("../db");
const logger = require("../logger");

// Access tokens are short-lived and stateless; refresh tokens are
// long-lived, stored hashed, and rotate on every use.
//
// The point of splitting them: a stolen access token is useless within
// minutes, and a stolen refresh token is DETECTABLE. Because each refresh
// invalidates the token that produced it, an old token being presented
// again means two parties hold the same credential - the real user and
// someone else. That's the signal the previous single-30-day-JWT model had
// no way to produce.

const ACCESS_TOKEN_TTL = "15m";
const REFRESH_TOKEN_TTL_DAYS = 30;

function hashToken(raw) {
  // SHA-256 rather than bcrypt: these are 256 bits of random already, so
  // there's nothing to brute-force, and refresh happens often enough that
  // a deliberately slow hash would be a real cost for no benefit.
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function issueAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      name: user.name,
      session_version: user.session_version ?? 0,
    },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

async function issueRefreshToken(user, { familyId = null, context = {} } = {}) {
  const raw = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  const { rows } = await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      user.id,
      hashToken(raw),
      familyId || crypto.randomUUID(),
      context.userAgent?.slice(0, 500) || null,
      context.ip || null,
      expiresAt,
    ]
  );
  return { raw, record: rows[0] };
}

// Revokes every token in a family. Used when reuse is detected: at that
// point we can't tell the legitimate holder from the attacker, so the safe
// move is to invalidate both and make the user sign in again.
async function revokeFamily(familyId, reason) {
  await query(
    `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = $1
     WHERE family_id = $2 AND revoked_at IS NULL`,
    [reason, familyId]
  );
}

class TokenError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Exchanges a refresh token for a new access token AND a new refresh
// token, invalidating the presented one.
async function rotateInTransaction(rawToken, context = {}) {
  const tokenHash = hashToken(rawToken);

  return withTransaction(async (tx) => {
    // FOR UPDATE so two concurrent refreshes with the same token serialize
    // - otherwise both would pass the "not used yet" check and the reuse
    // detection would never fire.
    const { rows } = await tx(
      "SELECT * FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE",
      [tokenHash]
    );
    const token = rows[0];
    if (!token) throw new TokenError(401, "Invalid session.", "unknown_token");

    // Reuse detection. A token that was already exchanged is being
    // presented a second time: either an attacker replaying a stolen one,
    // or the real user replaying after an attacker already rotated. Both
    // mean the family is compromised.
    //
    // The revocation deliberately does NOT happen here. Throwing inside
    // the transaction rolls it back - which would silently discard the
    // security response and leave the compromised family fully usable.
    // Instead the caller is told to revoke after the transaction settles.
    if (token.used_at || token.revoked_at) {
      return { reuseDetected: true, familyId: token.family_id, userId: token.user_id };
    }

    if (new Date(token.expires_at) < new Date()) {
      throw new TokenError(401, "Session expired. Please sign in again.", "expired");
    }

    const { rows: userRows } = await tx("SELECT * FROM users WHERE id = $1", [token.user_id]);
    const user = userRows[0];
    if (!user) throw new TokenError(401, "Invalid session.", "unknown_user");

    // "Log out everywhere" bumps session_version; a refresh token issued
    // before that must stop working, or the feature wouldn't actually log
    // anything out.
    if ((token.session_version ?? user.session_version) !== user.session_version) {
      throw new TokenError(401, "Session ended. Please sign in again.", "revoked");
    }

    const raw = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    const { rows: newRows } = await tx(
      `INSERT INTO refresh_tokens (user_id, token_hash, family_id, user_agent, ip, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [user.id, hashToken(raw), token.family_id, context.userAgent?.slice(0, 500) || null, context.ip || null, expiresAt]
    );

    await tx(
      "UPDATE refresh_tokens SET used_at = now(), replaced_by_id = $1 WHERE id = $2",
      [newRows[0].id, token.id]
    );

    return { accessToken: issueAccessToken(user), refreshToken: raw, user };
  });
}

// Wraps the transactional part so reuse revocation happens AFTER the
// transaction commits. Inside it, the throw that reports the problem would
// also roll back the revocation that responds to it.
async function rotateToken(rawToken, context = {}) {
  const result = await rotateInTransaction(rawToken, context);

  if (result?.reuseDetected) {
    await revokeFamily(result.familyId, "reuse_detected");
    logger.error("refresh_token_reuse_detected", {
      userId: result.userId,
      familyId: result.familyId,
      ip: context.ip,
    });
    throw new TokenError(
      401,
      "Your session was ended for security reasons. Please sign in again.",
      "reuse_detected"
    );
  }

  return result;
}

// The user's own active sessions, so they can see and end them
// individually - the previous model could only log out everything at once.
async function listSessions(userId) {
  const { rows } = await query(
    `SELECT id, family_id, user_agent, ip, issued_at, expires_at
     FROM refresh_tokens
     WHERE user_id = $1 AND revoked_at IS NULL AND used_at IS NULL AND expires_at > now()
     ORDER BY issued_at DESC`,
    [userId]
  );
  return rows;
}

async function revokeSession(userId, familyId) {
  const { rowCount } = await query(
    `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'user_revoked'
     WHERE user_id = $1 AND family_id = $2 AND revoked_at IS NULL`,
    [userId, familyId]
  );
  return rowCount > 0;
}

async function revokeAllForUser(userId, reason = "user_logout_everywhere") {
  await query(
    `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = $1
     WHERE user_id = $2 AND revoked_at IS NULL`,
    [reason, userId]
  );
}

module.exports = {
  TokenError,
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL_DAYS,
  hashToken,
  issueAccessToken,
  issueRefreshToken,
  rotate: rotateToken,
  revokeFamily,
  listSessions,
  revokeSession,
  revokeAllForUser,
};
