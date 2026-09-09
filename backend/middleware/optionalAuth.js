const jwt = require("jsonwebtoken");
const { COOKIE_NAME } = require("../auth/cookieConfig");

// Populates req.user IF a valid session cookie is present, but never
// rejects. Used on public endpoints that behave slightly differently when
// someone is signed in - specifically, attributing a listing view to a
// user (and skipping the seller's own views) without making the listing
// page require an account.
//
// Deliberately does NOT check session_version like requireAuth does: this
// only affects analytics attribution, never authorization, so the extra
// per-request database lookup isn't justified on a public browse path.
function optionalAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return next();
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email, name: payload.name };
  } catch {
    // An expired or malformed token just means "treat as anonymous" here.
  }
  next();
}

module.exports = optionalAuth;
