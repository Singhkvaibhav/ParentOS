const request = require("supertest");
require("../tests/setupEnv");

jest.mock("../ai/controller", () => ({
  AiUnavailableError: class extends Error {},
  getAutoReply: jest.fn().mockResolvedValue("Mocked auto-reply."),
}));

const app = require("../server");
const { createVerifiedUser } = require("./helpers");
const { resetDb } = require("./dbReset");
const { query } = require("../db");
const { notify } = require("../services/notificationsService");

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
});

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

const VALID_TOKEN = "ExponentPushToken[abcDEF123-fake-token]";

// notify() is deliberately fire-and-forget (see notificationsService.js),
// so a test asserting on its effects has to wait for that untracked
// promise to settle somehow. A fixed setTimeout(50) did this before and
// was genuinely flaky under load - it failed for real in a slow CI-like
// run, not a false alarm - because 50ms is a guess, not a fact about how
// long the notify->push chain takes. Polling for the actual condition
// with a generous ceiling is correct regardless of how loaded the machine
// running this happens to be.
async function waitUntil(predicate, { timeout = 3000, interval = 20 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

describe("registering a push token", () => {
  test("rejects a malformed token", async () => {
    const user = await createVerifiedUser(app, { email: "push1@example.com" });
    const res = await user.agent.post("/api/v1/notifications/push-token").send({ token: "not-a-real-token", platform: "ios" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalidPushToken");
  });

  test("rejects an invalid platform", async () => {
    const user = await createVerifiedUser(app, { email: "push2@example.com" });
    const res = await user.agent.post("/api/v1/notifications/push-token").send({ token: VALID_TOKEN, platform: "windows-phone" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalidPlatform");
  });

  test("accepts a well-formed token and records it against the caller", async () => {
    const user = await createVerifiedUser(app, { email: "push3@example.com" });
    const res = await user.agent.post("/api/v1/notifications/push-token").send({ token: VALID_TOKEN, platform: "ios" });
    expect(res.status).toBe(200);

    const { rows } = await query("SELECT user_id, platform FROM push_tokens WHERE token = $1", [VALID_TOKEN]);
    expect(rows[0].user_id).toBe(user.user.id);
    expect(rows[0].platform).toBe("ios");
  });

  test("re-registering the same token to a different user reassigns it, not duplicates it", async () => {
    const first = await createVerifiedUser(app, { email: "push4a@example.com" });
    const second = await createVerifiedUser(app, { email: "push4b@example.com" });
    const token = "ExponentPushToken[shared-device-token]";

    await first.agent.post("/api/v1/notifications/push-token").send({ token, platform: "android" });
    await second.agent.post("/api/v1/notifications/push-token").send({ token, platform: "android" });

    const { rows } = await query("SELECT user_id FROM push_tokens WHERE token = $1", [token]);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(second.user.id);
  });

  test("requires authentication", async () => {
    // 403 (missing CSRF token), not 401 - an unauthenticated request with
    // no cookie at all fails the CSRF check before requireAuth ever runs,
    // same convention as every other mutating route (see directupload.test.js).
    const res = await request(app).post("/api/v1/notifications/push-token").send({ token: VALID_TOKEN, platform: "ios" });
    expect(res.status).toBe(403);
  });
});

describe("unregistering a push token", () => {
  test("removes the caller's own token", async () => {
    const user = await createVerifiedUser(app, { email: "push5@example.com" });
    const token = "ExponentPushToken[to-be-removed]";
    await user.agent.post("/api/v1/notifications/push-token").send({ token, platform: "ios" });

    const del = await user.agent.delete("/api/v1/notifications/push-token").send({ token });
    expect(del.status).toBe(200);

    const { rows } = await query("SELECT 1 FROM push_tokens WHERE token = $1", [token]);
    expect(rows).toHaveLength(0);
  });

  test("cannot remove another user's token", async () => {
    const owner = await createVerifiedUser(app, { email: "push6a@example.com" });
    const attacker = await createVerifiedUser(app, { email: "push6b@example.com" });
    const token = "ExponentPushToken[owned-by-owner]";
    await owner.agent.post("/api/v1/notifications/push-token").send({ token, platform: "ios" });

    await attacker.agent.delete("/api/v1/notifications/push-token").send({ token });

    const { rows } = await query("SELECT 1 FROM push_tokens WHERE token = $1", [token]);
    expect(rows).toHaveLength(1); // still there - the attacker's delete matched nothing
  });
});

describe("notify() sends push to every registered device for that user", () => {
  test("a notification triggers an Expo push send with the right payload", async () => {
    const user = await createVerifiedUser(app, { email: "push7@example.com" });
    await user.agent.post("/api/v1/notifications/push-token").send({ token: VALID_TOKEN, platform: "ios" });

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ status: "ok" }] }),
    });
    global.fetch = fetchMock;

    // listingId omitted - notify() writes it straight into a foreign key
    // column, so a made-up id would fail the INSERT (and, being fired
    // fire-and-forget, fail silently from this test's point of view).
    notify({ userId: user.user.id, type: "item_sold", title: "Your item sold!", body: "Someone bought your listing." });
    await waitUntil(() => fetchMock.mock.calls.length > 0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://exp.host/--/api/v2/push/send");
    const sent = JSON.parse(options.body);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: VALID_TOKEN,
      title: "Your item sold!",
      body: "Someone bought your listing.",
      data: { type: "item_sold" },
    });
  });

  test("a DeviceNotRegistered response deletes the dead token", async () => {
    const user = await createVerifiedUser(app, { email: "push8@example.com" });
    const token = "ExponentPushToken[dead-device]";
    await user.agent.post("/api/v1/notifications/push-token").send({ token, platform: "ios" });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } }] }),
    });

    notify({ userId: user.user.id, type: "message_received", title: "New message" });
    await waitUntil(async () => {
      const { rows } = await query("SELECT 1 FROM push_tokens WHERE token = $1", [token]);
      return rows.length === 0;
    });
  });

  test("a user with no registered device gets no push attempt, and notify() still succeeds", async () => {
    const user = await createVerifiedUser(app, { email: "push9@example.com" });
    const fetchMock = jest.fn();
    global.fetch = fetchMock;

    notify({ userId: user.user.id, type: "review_received", title: "New review" });
    // Proving an absence, not waiting for a condition - waitUntil doesn't
    // apply. A fixed pause here is the right tool, just a generous one:
    // this only needs to outlast notify()'s own DB round-trip (see
    // sendPush's early return on zero tokens), not model system load.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
