const crypto = require("crypto");
const { API_PREFIX } = require("../config");

// CSRF protection via the double-submit cookie pattern.
//
// Why this is needed now: auth is an httpOnly cookie, which the browser
// attaches automatically to ANY request to this origin - including one
// triggered by a malicious third-party page. SameSite=Lax (already set,
// see auth/cookieConfig.js) blocks the common cases, but it's a defense
// that varies by browser version and doesn't cover everything, so it
// shouldn't be the only layer protecting state-changing endpoints.
//
// How it works: a random token is set in a NON-httpOnly cookie (so the
// frontend's JS can read it) and must be echoed back in a request header.
// An attacker's page can cause the browser to *send* our cookies, but the
// same-origin policy stops it from *reading* them - so it can't produce
// the matching header. Legitimate first-party JS can.
const CSRF_COOKIE_NAME = "parentos_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function csrfCookieOptions() {
  return {
    httpOnly: false, // deliberately readable by our own JS - that's the whole mechanism
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  };
}

// Issues a CSRF token to any client that doesn't have one yet. Runs on
// every request so a freshly-loaded page always has one available before
// it needs to make its first state-changing call.
function issueCsrfToken(req, res, next) {
  if (!req.cookies?.[CSRF_COOKIE_NAME]) {
    res.cookie(CSRF_COOKIE_NAME, crypto.randomBytes(32).toString("hex"), csrfCookieOptions());
  }
  next();
}

function requireCsrfToken(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  // The Stripe webhook is a server-to-server POST from Stripe's
  // infrastructure - there's no browser, no cookie, and therefore no CSRF
  // risk to protect against. It's authenticated instead by verifying
  // Stripe's signature over the raw body (see transactionsService).
  if (req.path === `${API_PREFIX}/transactions/webhook`) return next();

  // CSRF exploits *ambient* credentials - a cookie the browser attaches
  // automatically, to any site, without the page's JS doing anything. A
  // Bearer token only travels because a client explicitly reads it from
  // storage and sets the header itself; a malicious third-party page can
  // make a victim's browser *send* cookies, but it cannot make a native
  // mobile app attach a header the app didn't choose to attach. So a
  // request authenticated this way (see requireAuth.js) has no CSRF risk
  // to protect against either.
  if (req.get("authorization")?.match(/^Bearer /i)) return next();

  // The mobile client has no cookie jar and no way to read a non-httpOnly
  // cookie's value the way browser JS reads document.cookie, so it can't
  // participate in the double-submit dance at all - including on
  // pre-login routes like signup, where there's no Bearer token yet
  // either (no session exists to attach one from). These routes (see
  // auth/routes.js) don't rely on an ambient cookie to decide who an
  // action applies to in the first place - signup, resend-code and
  // forgot/reset-password all take the identifying value (email or an
  // emailed token) explicitly in the body - so exempting them doesn't
  // weaken what CSRF protection here actually defends.
  if (req.path.startsWith(`${API_PREFIX}/auth/mobile/`)) return next();

  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
  const headerToken = req.get(CSRF_HEADER_NAME);

  if (!cookieToken || !headerToken) {
    return res.status(403).json({ error: "Missing CSRF token." });
  }

  // Constant-time comparison - a plain !== would leak, through response
  // timing, how much of a guessed token was correct.
  const a = Buffer.from(cookieToken);
  const b = Buffer.from(headerToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: "Invalid CSRF token." });
  }

  next();
}

module.exports = { issueCsrfToken, requireCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME };
