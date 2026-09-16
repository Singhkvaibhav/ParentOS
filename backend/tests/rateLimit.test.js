require("../tests/setupEnv");

// (P1 before horizontal scaling) express-rate-limit's default store counts
// hits in each process's own memory - with N horizontally-scaled API
// instances, a user effectively gets N times the configured allowance,
// since no instance knows what the others have already counted. This tests
// the store-selection logic that fixes that (middleware/rateLimit.js's
// storeFor): no REDIS_URL falls back to express-rate-limit's own in-memory
// store, REDIS_URL configured wires up a RedisStore so every instance
// shares one count.
//
// ioredis is mocked rather than pointed at a real (or deliberately
// unreachable) address: RedisStore's constructor eagerly fires two
// `SCRIPT LOAD` commands to warm its Lua scripts, and a real ioredis client
// against an address with nothing listening keeps retrying to reconnect
// forever by default (that's the right behaviour in production - Redis
// restarting mid-deploy shouldn't be treated as permanent) - which in a
// test just means a dangling timer that keeps the process alive and jest
// from exiting. What's worth locking in here is the selection logic itself
// (falls back correctly when unconfigured; wires up the right shape, with
// a distinct prefix per limiter, when configured) - an actual Redis
// round-trip is exactly the kind of environment-dependent behaviour this
// suite skips in NODE_ENV=test already (see rateLimit.js's skipInTests),
// same as the rest of this module's limiters.
// RedisStore's constructor fires two fire-and-forget SCRIPT LOAD commands
// to warm its Lua scripts (see loadIncrementScript/loadGetScript in
// rate-limit-redis) - `call` has to resolve to a string, or that unawaited
// promise rejects with "unexpected reply from redis client" and jest
// reports it as an unhandled rejection even though every assertion below
// still passes.
jest.mock("ioredis", () => jest.fn().mockImplementation(() => ({
  on: jest.fn(),
  call: jest.fn().mockResolvedValue("fake-script-sha"),
})));

describe("rate limiting: Redis store selection", () => {
  const ORIGINAL_REDIS_URL = process.env.REDIS_URL;

  afterEach(() => {
    if (ORIGINAL_REDIS_URL === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = ORIGINAL_REDIS_URL;
    jest.resetModules();
  });

  test("without REDIS_URL, falls back to express-rate-limit's own in-memory store", () => {
    delete process.env.REDIS_URL;
    jest.resetModules();
    const { storeFor } = require("../middleware/rateLimit");

    expect(storeFor("login")).toBeUndefined();
  });

  test("with REDIS_URL configured, wires up a RedisStore", () => {
    process.env.REDIS_URL = "redis://fake-redis-host:6379";
    jest.resetModules();
    const { storeFor } = require("../middleware/rateLimit");
    const { RedisStore } = require("rate-limit-redis");

    const store = storeFor("login");

    expect(store).toBeInstanceOf(RedisStore);
    expect(typeof store.sendCommand).toBe("function");
  });

  test("different limiters get different key prefixes, so they can't collide on the same IP/user key", () => {
    process.env.REDIS_URL = "redis://fake-redis-host:6379";
    jest.resetModules();
    const { storeFor } = require("../middleware/rateLimit");

    const loginStore = storeFor("login");
    const signupStore = storeFor("signup");

    expect(loginStore.prefix).not.toBe(signupStore.prefix);
    expect(loginStore.prefix).toBe("rl:login:");
    expect(signupStore.prefix).toBe("rl:signup:");
  });

  test("all limiters configured in the module share one underlying Redis connection", () => {
    process.env.REDIS_URL = "redis://fake-redis-host:6379";
    jest.resetModules();
    const { storeFor } = require("../middleware/rateLimit");
    const Redis = require("ioredis");

    // Building every limiter's store must not open a Redis connection per
    // limiter - one API instance should hold exactly one.
    storeFor("login");
    storeFor("signup");
    storeFor("resend-code");
    storeFor("verify");
    storeFor("message");
    storeFor("ai-user");
    storeFor("ai-ip");

    expect(Redis).toHaveBeenCalledTimes(1);
  });
});
