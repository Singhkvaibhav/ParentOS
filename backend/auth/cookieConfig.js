// Shared cookie settings for the auth token, so login/verify (which set it)
// and logout (which clears it) can't drift out of sync with each other.
//
// `secure: true` in production means this cookie is only ever sent over
// HTTPS - make sure your real deployment actually terminates TLS in front
// of this app, or the browser will silently refuse to send the cookie at
// all and every request will look logged-out.
//
// `sameSite: 'lax'` is right when frontend and backend share a site (same
// domain, or dev via the Vite proxy so the browser sees same-origin
// requests - see frontend/vite.config.js). If you deploy frontend and
// backend on genuinely different domains, this needs to become
// `sameSite: 'none'` (which requires `secure: true`, i.e. HTTPS) instead,
// or the browser won't attach the cookie to cross-site requests.
const COOKIE_NAME = "parentos_token";
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, matching the JWT's own expiry

// Attributes that must match between setting and clearing for the browser
// to recognize it as the same cookie (path/secure/sameSite) - but NOT
// maxAge: res.clearCookie() normally forces an immediate-expiry cookie, and
// passing maxAge here would override that with a real 30-day expiry on the
// (now-empty) cookie instead of actually deleting it.
function baseCookieAttributes() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  };
}

function cookieOptions() {
  return { ...baseCookieAttributes(), maxAge: COOKIE_MAX_AGE_MS };
}

function clearCookieOptions() {
  return baseCookieAttributes();
}

module.exports = { COOKIE_NAME, cookieOptions, clearCookieOptions };
