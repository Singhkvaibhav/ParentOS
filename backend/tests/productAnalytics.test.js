require("../tests/setupEnv");

// Set BEFORE requiring the module under test - it reads POSTHOG_API_KEY at
// load time to decide whether it's enabled at all, the same pattern as
// errorTracking.js's DSN check.
process.env.POSTHOG_API_KEY = "phc_test_key_for_jest";

const mockCapture = jest.fn();
const mockShutdown = jest.fn().mockResolvedValue(undefined);
jest.mock("posthog-node", () => ({
  PostHog: jest.fn().mockImplementation(() => ({
    capture: mockCapture,
    shutdown: mockShutdown,
  })),
}));

const productAnalytics = require("../services/productAnalyticsService");

afterEach(() => {
  mockCapture.mockClear();
  mockShutdown.mockClear();
});

describe("productAnalyticsService, configured", () => {
  test("reports itself enabled once POSTHOG_API_KEY is set", () => {
    expect(productAnalytics.ENABLED).toBe(true);
  });

  test("capture() forwards distinctId, event and properties to the client", () => {
    productAnalytics.capture(42, "item_sold", { listingId: 7 });
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: "42", // coerced to a string - PostHog's distinct_id is always a string
      event: "item_sold",
      properties: { listingId: 7 },
    });
  });

  test("capture() defaults properties to an empty object", () => {
    productAnalytics.capture(1, "user_signed_up");
    expect(mockCapture).toHaveBeenCalledWith({ distinctId: "1", event: "user_signed_up", properties: {} });
  });

  test("a throwing client does not throw out of capture() - fire-and-forget, like notify()", () => {
    mockCapture.mockImplementationOnce(() => {
      throw new Error("network down");
    });
    expect(() => productAnalytics.capture(1, "user_signed_up")).not.toThrow();
  });

  test("shutdown() flushes the underlying client", async () => {
    await productAnalytics.shutdown();
    expect(mockShutdown).toHaveBeenCalledTimes(1);
  });
});

describe("productAnalyticsService, unconfigured", () => {
  test("capture() is a silent no-op without POSTHOG_API_KEY", () => {
    jest.resetModules();
    const originalKey = process.env.POSTHOG_API_KEY;
    delete process.env.POSTHOG_API_KEY;

    const unconfigured = require("../services/productAnalyticsService");
    expect(unconfigured.ENABLED).toBe(false);
    expect(() => unconfigured.capture(1, "user_signed_up")).not.toThrow();

    process.env.POSTHOG_API_KEY = originalKey;
  });
});
