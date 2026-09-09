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
router.post("/forgot-password", resendCodeLimiter, controller.forgotPassword);
router.post("/reset-password", verifyLimiter, controller.resetPassword);

// Lets a user see where their account has been signed in from - the
// evidence they need to decide whether to log out everywhere.
router.get("/login-history", requireAuth, controller.loginHistory);

module.exports = router;
