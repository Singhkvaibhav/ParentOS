const rateLimit = require("express-rate-limit");

// Auth endpoints are the classic brute-force targets: password guessing on
// login, spamming accounts on signup, and guessing the 6-digit verification
// code. Limits are per-IP; fine for this stage, but a shared IP (office
// NAT, campus wifi) will hit them faster than a single attacker would - a
// real launch would want per-account limits layered on top of this.
//
// Skipped entirely in NODE_ENV=test: the test suite legitimately creates
// many accounts quickly to exercise different scenarios, and that's a
// testing artifact, not something worth asserting on here. Real rate
// limiting behaviour was verified manually against a running server.
const skipInTests = () => process.env.NODE_ENV === "test";

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: "Too many login attempts - try again in a few minutes." },
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: "Too many accounts created from this network - try again later." },
});

const resendCodeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: "Too many code requests - try again later." },
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20, // generous at the IP level - the real brake is the per-account attempt counter in the controller
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: "Too many verification attempts - try again in a few minutes." },
});

// (P1 #3) Messaging and AI limits are keyed per-USER, not per-IP. These
// endpoints require a login, so the identity is known - and a per-IP limit
// would be the wrong control anyway: an abuser can rotate IPs trivially,
// while a family sharing one connection would be punished for each other's
// use. The IP is only the fallback for the (shouldn't-happen) unauthenticated case.
const perUser = (req) => (req.user?.id ? `user:${req.user.id}` : `ip:${req.ip}`);

const messageLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60, // a very talkative but genuine buyer sends nowhere near this
  keyGenerator: perUser,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: "You're sending messages very quickly - take a short break and try again." },
});

// The AI auto-reply costs real money per call, so it gets a tighter budget
// than messaging generally. Two limits deliberately layered: per-user
// stops one account burning the budget, per-IP stops someone spreading the
// same abuse across many throwaway accounts from one machine.
const aiPerUserLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  keyGenerator: perUser,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: "Too many automatic replies requested - try again later." },
});

const aiPerIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: "Too many automatic replies from this network - try again later." },
});

module.exports = {
  loginLimiter, signupLimiter, resendCodeLimiter, verifyLimiter,
  messageLimiter, aiPerUserLimiter, aiPerIpLimiter,
};
