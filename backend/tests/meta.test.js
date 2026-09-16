const request = require("supertest");
require("../tests/setupEnv");

jest.mock("../ai/controller", () => ({
  AiUnavailableError: class extends Error {},
  getAutoReply: jest.fn().mockResolvedValue("Mocked auto-reply."),
}));

const app = require("../server");

beforeAll(async () => {
  await app.dbReady;
});

// The frontend derives its category/condition options from this endpoint,
// keeping only presentation (label, icon) locally. These assertions lock
// that contract in: if the endpoint stops publishing a field, the UI
// silently loses options rather than failing loudly, so it's worth a test.
describe("config is the single source of truth for marketplace rules", () => {
  test("publishes every field the frontend depends on", async () => {
    const res = await request(app).get("/api/v1/meta/config");
    expect(res.status).toBe(200);

    for (const field of ["categories", "conditions", "deliveryFeeCents", "maxPriceCents", "limits"]) {
      expect(res.body).toHaveProperty(field);
    }
    expect(Array.isArray(res.body.categories)).toBe(true);
    expect(res.body.categories.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.conditions)).toBe(true);
    expect(res.body.conditions.length).toBeGreaterThan(0);
  });

  test("the categories it publishes are exactly the ones listings accept", async () => {
    // If these diverge, the UI offers options the API rejects (or hides
    // ones it would accept) - the drift this endpoint exists to prevent.
    const { CATEGORY_SET } = require("../config");
    const res = await request(app).get("/api/v1/meta/config");
    expect([...res.body.categories].sort()).toEqual([...CATEGORY_SET].sort());
  });

  test("the conditions it publishes are exactly the ones listings accept", async () => {
    const { CONDITION_SET } = require("../config");
    const res = await request(app).get("/api/v1/meta/config");
    expect([...res.body.conditions].sort()).toEqual([...CONDITION_SET].sort());
  });

  test("requires no authentication - the UI needs it before login", async () => {
    const res = await request(app).get("/api/v1/meta/config");
    expect(res.status).toBe(200);
  });
});

// The transaction status groups are the other place a "single source of
// truth" claim needs enforcing, since four services now read from them.
describe("transaction status groups", () => {
  const status = require("../transactionStatus");

  test("every grouped status is a real status", () => {
    const groups = [
      status.MONEY_CAPTURED, status.AWAITING_HANDOVER,
      status.CONCLUDED, status.REVERSED, status.IN_FLIGHT_FOR_MODERATION,
    ];
    for (const group of groups) {
      for (const s of group) expect(status.ALL_STATUSES).toContain(s);
    }
  });

  test("sqlList rejects an unknown status rather than emitting bad SQL", () => {
    // A typo in a group would otherwise produce a filter matching nothing,
    // which reads as "no sales yet" rather than as a bug.
    expect(() => status.sqlList(["not_a_status"])).toThrow(/Unknown transaction status/);
  });

  test("CONCLUDED means completed only - never merely paid", () => {
    // This is the invariant behind the trust counters and review
    // eligibility; if it ever widens, both silently become wrong.
    expect(status.CONCLUDED).toEqual([status.STATUS.COMPLETED]);
    expect(status.CONCLUDED).not.toContain(status.STATUS.PAID);
  });

  test("every status has a transition list, so none is a dead end by accident", () => {
    for (const s of status.ALL_STATUSES) {
      expect(status.VALID_TRANSITIONS).toHaveProperty(s);
    }
  });
});
