// Thin HTTP layer - all the actual logic lives in services/authService.js.
// The one HTTP-specific concern that lives here rather than in the service:
// putting the JWT in an httpOnly cookie instead of the JSON response body,
// so client-side JS (and anything that can run in the page, e.g. an XSS
// payload) can never read the token at all - a strict improvement over the
// earlier localStorage approach.
const authService = require("../services/authService");
const { COOKIE_NAME, cookieOptions, clearCookieOptions } = require("./cookieConfig");

function handleServiceError(res, e) {
  if (e instanceof authService.AuthError) {
    const { status, message, ...extra } = e;
    return res.status(status).json({ error: message, ...extra });
  }
  throw e; // let express-async-errors / the global error handler deal with anything unexpected
}

function respondWithSession(res, { token, user }, extra = {}) {
  res.cookie(COOKIE_NAME, token, cookieOptions());
  res.json({ user, ...extra });
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
    respondWithSession(res, await authService.verify(req.body));
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function login(req, res) {
  try {
    // IP and user agent feed lockout accounting and the "we haven't seen
    // this device before" check.
    respondWithSession(res, await authService.login(req.body, {
      ip: req.ip,
      userAgent: req.get("user-agent"),
    }));
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function logout(req, res) {
  res.clearCookie(COOKIE_NAME, clearCookieOptions());
  res.json({ ok: true });
}

// Ends every *other* session for this user (see authService) and issues a
// fresh token for the current one, so the device making the request stays
// signed in while all others are evicted.
async function logoutEverywhere(req, res) {
  try {
    const { token, user } = await authService.logoutEverywhere(req.user.id);
    res.cookie(COOKIE_NAME, token, cookieOptions());
    res.json({ user });
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
      return res.status(e.status).json({ error: e.message });
    }
    throw e;
  }
}

async function loginHistory(req, res) {
  res.json({ events: await accountSecurity.loginHistory(req.user.id) });
}

module.exports = {
  forgotPassword,
  resetPassword,
  loginHistory, signup, resendCode, verify, login, logout, logoutEverywhere, me };
