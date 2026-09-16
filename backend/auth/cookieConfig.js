const { API_PREFIX } = require("../config");

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
// The access token is short-lived, so its cookie is too. A cookie that
// outlives the JWT inside it just means the browser keeps sending a token
// the server will reject.
const COOKIE_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes, matching ACCESS_TOKEN_TTL

// The refresh token lives in a SEPARATE cookie scoped to the refresh
// endpoint. Scoping the path means the browser never attaches it to
// ordinary API calls, so the long-lived credential isn't exposed on every
// request the way a single 30-day cookie was.
const REFRESH_COOKIE_NAME = "parentos_refresh";
// Scoped to /api/v1/auth rather than just /api/v1/auth/refresh: logout also
// has to see this cookie in order to REVOKE the token server-side, and a
// cookie scoped to the refresh path alone is never sent to
// /api/v1/auth/logout - so logout could only clear the browser's copy
// while leaving the token itself valid for anyone who had captured it.
//
// Still keeps the long-lived credential off every ordinary API request
// (/api/v1/listings, /api/v1/messages and so on), which was the point.
const REFRESH_COOKIE_PATH = `${API_PREFIX}/auth`;
const REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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

function refreshCookieOptions() {
  return { ...baseCookieAttributes(), path: REFRESH_COOKIE_PATH, maxAge: REFRESH_COOKIE_MAX_AGE_MS };
}

// Path must match for the browser to recognize it as the same cookie.
function clearRefreshCookieOptions() {
  return { ...baseCookieAttributes(), path: REFRESH_COOKIE_PATH };
}

module.exports = {
  COOKIE_NAME, cookieOptions, clearCookieOptions,
  REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH, refreshCookieOptions, clearRefreshCookieOptions,
};
