const rateLimit = require("express-rate-limit");
const logger = require("../logger");

// (P1 before horizontal scaling) express-rate-limit's default store counts
// hits in the process's own memory. Fine for one API instance; with
// `docker compose up --scale api=3` each instance keeps its own count, so a
// user effectively gets 3x the configured allowance (each of the 3
// instances lets them through up to the limit before any of them says no).
// Backed by Redis instead when REDIS_URL is configured, so every instance
// shares one count - the same optional-Redis pattern the queue (see
// queue/index.js) and product analytics already use, so running locally or
// in CI never requires standing up Redis just to boot the app.
const REDIS_URL = process.env.REDIS_URL || "";
const REDIS_ENABLED = !!REDIS_URL;

let redisClient = null;
function getRedisClient() {
  if (!redisClient) {
    const Redis = require("ioredis");
    redisClient = new Redis(REDIS_URL, {
      // Rate limiting is best-effort infrastructure, not a durable queue: a
      // slow/unreachable Redis should fail one check fast - passOnStoreError
      // below then allows the request through - rather than pile up retries
      // or queue commands while a request is waiting on this middleware.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      // Connects on first actual command (the first rate-limited request),
      // not at module load - a REDIS_URL that's misconfigured or briefly
      // unreachable at boot shouldn't be the reason the whole server won't
      // start, and it keeps constructing a store (see storeFor) side-effect-free.
      lazyConnect: true,
    });
    redisClient.on("error", (e) => logger.warn("rate_limit_redis_connection_error", { err: e.message }));
  }
  return redisClient;
}

// A fresh RedisStore per limiter rather than one shared instance - each
// needs its own key prefix so e.g. loginLimiter and signupLimiter (both
// keyed by the same IP by default) don't increment the same Redis key.
// Returns undefined when Redis isn't configured, which makes
// express-rate-limit fall back to its own built-in in-memory store.
function storeFor(prefix) {
  if (!REDIS_ENABLED) return undefined;
  const { RedisStore } = require("rate-limit-redis");
  const client = getRedisClient();
  return new RedisStore({
    prefix: `rl:${prefix}:`,
    sendCommand: (...args) => client.call(...args),
  });
}

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
  store: storeFor("login"),
  passOnStoreError: true,
  message: { error: "Too many login attempts - try again in a few minutes." },
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  store: storeFor("signup"),
  passOnStoreError: true,
  message: { error: "Too many accounts created from this network - try again later." },
});

const resendCodeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  store: storeFor("resend-code"),
  passOnStoreError: true,
  message: { error: "Too many code requests - try again later." },
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20, // generous at the IP level - the real brake is the per-account attempt counter in the controller
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  store: storeFor("verify"),
  passOnStoreError: true,
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
  store: storeFor("message"),
  passOnStoreError: true,
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
  store: storeFor("ai-user"),
  passOnStoreError: true,
  message: { error: "Too many automatic replies requested - try again later." },
});

const aiPerIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  store: storeFor("ai-ip"),
  passOnStoreError: true,
  message: { error: "Too many automatic replies from this network - try again later." },
});

module.exports = {
  loginLimiter, signupLimiter, resendCodeLimiter, verifyLimiter,
  messageLimiter, aiPerUserLimiter, aiPerIpLimiter,
  // Exported for direct unit testing of the store-selection/prefixing logic
  // (see tests/rateLimit.test.js) - not meant for use outside this module.
  storeFor,
};
