// Thin HTTP layer - all the actual logic lives in services/authService.js.
// The one HTTP-specific concern that lives here rather than in the service:
// putting the JWT in an httpOnly cookie instead of the JSON response body,
// so client-side JS (and anything that can run in the page, e.g. an XSS
// payload) can never read the token at all - a strict improvement over the
// earlier localStorage approach.
const authService = require("../services/authService");
const {
  COOKIE_NAME, cookieOptions, clearCookieOptions,
  REFRESH_COOKIE_NAME, refreshCookieOptions, clearRefreshCookieOptions,
} = require("./cookieConfig");
const { query } = require("../db");

function handleServiceError(res, e) {
  if (e instanceof authService.AuthError) {
    const { status, message, ...extra } = e;
    return res.status(status).json({ error: message, ...extra });
  }
  throw e; // let express-async-errors / the global error handler deal with anything unexpected
}

// Issues BOTH halves of the session: a short-lived access cookie and a
// path-scoped rotating refresh cookie.
//
// Previously this set a single 30-day JWT, which meant the refresh
// infrastructure existed in the database and in tokenService while the
// actual session was still one long-lived credential - the architecture and
// the behaviour disagreed.
async function respondWithSession(res, { token, user }, extra = {}, context = {}) {
  res.cookie(COOKIE_NAME, token, cookieOptions());

  const { issueRefreshToken } = require("../services/tokenService");
  const { rows } = await query("SELECT * FROM users WHERE id = $1", [user.id]);
  const { raw } = await issueRefreshToken(rows[0], { context });
  res.cookie(REFRESH_COOKIE_NAME, raw, refreshCookieOptions());

  res.json({ user, ...extra });
}

// Exchanges the refresh cookie for a fresh pair. The client calls this when
// an API request comes back 401, which is what keeps a 15-minute access
// token from meaning a 15-minute session.
async function refresh(req, res) {
  const { rotate, TokenError } = require("../services/tokenService");
  const presented = req.cookies?.[REFRESH_COOKIE_NAME];

  if (!presented) return res.status(401).json({ error: "No session to refresh." });

  try {
    const result = await rotate(presented, { ip: req.ip, userAgent: req.get("user-agent") });
    res.cookie(COOKIE_NAME, result.accessToken, cookieOptions());
    res.cookie(REFRESH_COOKIE_NAME, result.refreshToken, refreshCookieOptions());
    res.json({ user: { id: result.user.id, name: result.user.name, email: result.user.email, verified: !!result.user.verified, isAdmin: !!result.user.is_admin } });
  } catch (e) {
    if (e instanceof TokenError) {
      // Clear both cookies on any refresh failure. Leaving a dead refresh
      // token in the browser makes the client retry it forever, and on
      // reuse detection the family is already revoked anyway.
      res.clearCookie(COOKIE_NAME, clearCookieOptions());
      res.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOptions());
      return res.status(e.status).json({ error: e.message, code: e.code });
    }
    throw e;
  }
}

async function signup(req, res) {
  try {
    res.json(await authService.signup(req.body));
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function resendCode(req, res) {
  try {
    res.json(await authService.resendCode(req.body));
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function verify(req, res) {
  try {
    await respondWithSession(res, await authService.verify(req.body), {}, { ip: req.ip, userAgent: req.get("user-agent") });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function login(req, res) {
  try {
    // IP and user agent feed lockout accounting and the "we haven't seen
    // this device before" check.
    const context = { ip: req.ip, userAgent: req.get("user-agent") };
    await respondWithSession(res, await authService.login(req.body, context), {}, context);
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function logout(req, res) {
  // Revoke server-side as well as clearing the cookie. A refresh token the
  // browser merely forgets is still a working credential if it was ever
  // copied - logging out has to invalidate it, not just hide it.
  const presented = req.cookies?.[REFRESH_COOKIE_NAME];
  if (presented) {
    const { hashToken } = require("../services/tokenService");
    await query(
      `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'logout'
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashToken(presented)]
    );
  }

  res.clearCookie(COOKIE_NAME, clearCookieOptions());
  res.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOptions());
  res.json({ ok: true });
}

// Ends every *other* session for this user (see authService) and issues a
// fresh token for the current one, so the device making the request stays
// signed in while all others are evicted.
// --- Mobile session issuance ------------------------------------------
//
// Same authService functions as the web routes above - signup, the code
// itself, and password rules are identical for both clients. The only
// thing that differs is transport: a native app has no cookie jar, so
// these return the access and refresh tokens as plain JSON fields instead
// of setting httpOnly cookies. That's a deliberate, narrower trust model
// than the web flow (see requireAuth.js and middleware/csrf.js for the
// other half of it) - not a workaround, a different kind of client.

async function mobileVerify(req, res) {
  try {
    const { token, user } = await authService.verify(req.body);
    const { issueRefreshToken } = require("../services/tokenService");
    const { rows } = await query("SELECT * FROM users WHERE id = $1", [user.id]);
    const { raw } = await issueRefreshToken(rows[0], { context: { ip: req.ip, userAgent: req.get("user-agent") } });
    res.json({ user, accessToken: token, refreshToken: raw });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function mobileLogin(req, res) {
  try {
    const context = { ip: req.ip, userAgent: req.get("user-agent") };
    const { token, user } = await authService.login(req.body, context);
    const { issueRefreshToken } = require("../services/tokenService");
    const { rows } = await query("SELECT * FROM users WHERE id = $1", [user.id]);
    const { raw } = await issueRefreshToken(rows[0], { context });
    res.json({ user, accessToken: token, refreshToken: raw });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function mobileRefresh(req, res) {
  const { rotate, TokenError } = require("../services/tokenService");
  const presented = req.body?.refreshToken;
  if (!presented) return res.status(401).json({ error: "No session to refresh." });

  try {
    const result = await rotate(presented, { ip: req.ip, userAgent: req.get("user-agent") });
    res.json({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: {
        id: result.user.id, name: result.user.name, email: result.user.email,
        verified: !!result.user.verified, isAdmin: !!result.user.is_admin,
      },
    });
  } catch (e) {
    if (e instanceof TokenError) return res.status(e.status).json({ error: e.message, code: e.code });
    throw e;
  }
}

async function mobileLogout(req, res) {
  const presented = req.body?.refreshToken;
  if (presented) {
    const { hashToken } = require("../services/tokenService");
    await query(
      `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'logout'
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashToken(presented)]
    );
  }
  res.json({ ok: true });
}

async function logoutEverywhere(req, res) {
  try {
    const { token, user } = await authService.logoutEverywhere(req.user.id);

    // session_version alone only invalidates ACCESS tokens. Without this,
    // every other device could simply refresh its way back in, which would
    // make "log out everywhere" a 15-minute inconvenience rather than a
    // logout.
    const { revokeAllForUser } = require("../services/tokenService");
    await revokeAllForUser(req.user.id, "logout_everywhere");

    await respondWithSession(res, { token, user }, {}, {
      ip: req.ip, userAgent: req.get("user-agent"),
    });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function me(req, res) {
  try {
    res.json({ user: await authService.getById(req.user.id) });
  } catch (e) {
    handleServiceError(res, e);
  }
}

const accountSecurity = require("../services/accountSecurityService");

// Always 200, whether or not the address exists - see requestPasswordReset
// for why confirming an account's existence to an anonymous caller is
// itself a privacy leak for this product.
async function forgotPassword(req, res) {
  await accountSecurity.requestPasswordReset(req.body?.email, { ip: req.ip });
  res.json({ ok: true, message: "If that address has an account, a reset link is on its way." });
}

async function resetPassword(req, res) {
  try {
    res.json(await accountSecurity.resetPassword(req.body?.token, req.body?.password));
  } catch (e) {
    if (e instanceof accountSecurity.AccountSecurityError) {
      return res.status(e.status).json({ error: e.message, code: e.code });
    }
    throw e;
  }
}

async function loginHistory(req, res) {
  res.json({ events: await accountSecurity.loginHistory(req.user.id) });
}

module.exports = {
  refresh,
  forgotPassword,
  resetPassword,
  loginHistory, signup, resendCode, verify, login, logout, logoutEverywhere, me,
  mobileVerify, mobileLogin, mobileRefresh, mobileLogout,
};
