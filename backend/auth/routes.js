const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const { loginLimiter, signupLimiter, resendCodeLimiter, verifyLimiter } = require("../middleware/rateLimit");
const controller = require("./controller");

const router = express.Router();

router.post("/signup", signupLimiter, controller.signup);
router.post("/verify", verifyLimiter, controller.verify);
router.post("/resend-code", resendCodeLimiter, controller.resendCode);
router.post("/login", loginLimiter, controller.login);
router.post("/logout", controller.logout);
router.post("/logout-everywhere", requireAuth, controller.logoutEverywhere);
router.get("/me", requireAuth, controller.me);

// Password reset. Both are rate-limited: the request endpoint because it
// sends email, the confirm endpoint because it accepts a guessable token.
// Rotates the refresh cookie for a fresh access token. Rate-limited: it's
// unauthenticated by nature (the whole point is that the access token has
// expired), so it needs its own throttle.
router.post("/refresh", verifyLimiter, controller.refresh);

// Mobile client equivalents of /verify, /login, /refresh, /logout above -
// same service calls, tokens returned in the JSON body instead of set as
// cookies (see the mobile* controller functions for why).
router.post("/mobile/verify", verifyLimiter, controller.mobileVerify);
router.post("/mobile/login", loginLimiter, controller.mobileLogin);
router.post("/mobile/refresh", verifyLimiter, controller.mobileRefresh);
router.post("/mobile/logout", controller.mobileLogout);

// These four never touched cookies to begin with - the *same* handlers as
// above, just reachable at a path middleware/csrf.js exempts, since the
// mobile client has no cookie jar to produce the CSRF token from even for
// a pre-login request like signup.
router.post("/mobile/signup", signupLimiter, controller.signup);
router.post("/mobile/resend-code", resendCodeLimiter, controller.resendCode);
router.post("/mobile/forgot-password", resendCodeLimiter, controller.forgotPassword);
router.post("/mobile/reset-password", verifyLimiter, controller.resetPassword);

router.post("/forgot-password", resendCodeLimiter, controller.forgotPassword);
router.post("/reset-password", verifyLimiter, controller.resetPassword);

// Lets a user see where their account has been signed in from - the
// evidence they need to decide whether to log out everywhere.
router.get("/login-history", requireAuth, controller.loginHistory);

module.exports = router;
