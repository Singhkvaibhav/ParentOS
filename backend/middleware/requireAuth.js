const jwt = require("jsonwebtoken");
const { COOKIE_NAME } = require("../auth/cookieConfig");
const { query } = require("../db");

// Verifies the session cookie AND that the token hasn't been revoked.
//
// A plain JWT check alone can't be revoked - the signature stays valid for
// the token's full 30-day life regardless of what happens to the account.
// The extra session_version lookup here is what makes "log out everywhere"
// (and revoking a stolen token) possible: authService bumps the user's
// session_version, and every token issued before that bump immediately
// stops authenticating.
//
// This does add one small indexed lookup per authenticated request. That's
// the deliberate trade for revocability; if it ever shows up in profiling,
// the fix is caching session_version (e.g. in Redis), not dropping the
// check.
async function requireAuth(req, res, next) {
  // The web client authenticates via an httpOnly cookie - the whole point
  // being that page JS can never read the token. A native mobile client
  // has no browser cookie jar to rely on, so it authenticates instead with
  // a manually-attached `Authorization: Bearer <token>` header (issued by
  // the /api/v1/auth/mobile/* routes). Same JWT, same verification below -
  // only where it's read from differs, so a stolen mobile token is exactly
  // as revocable (via session_version) as a stolen web cookie.
  const bearerMatch = req.get("authorization")?.match(/^Bearer (.+)$/i);
  const token = req.cookies?.[COOKIE_NAME] || bearerMatch?.[1];
  if (!token) return res.status(401).json({ error: "Not logged in." });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: "Session expired — log in again." });
  }

  const { rows } = await query("SELECT session_version FROM users WHERE id = $1", [payload.sub]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error: "Session expired — log in again." });
  if (user.session_version !== payload.sv) {
    return res.status(401).json({ error: "Session ended — log in again." });
  }

  // `sub` is the standard JWT claim for user id - exposed as req.user.id
  // so every controller/service can keep using req.user.id regardless of
  // how the token encodes it under the hood.
  req.user = { id: payload.sub, email: payload.email, name: payload.name };
  next();
}

module.exports = requireAuth;
