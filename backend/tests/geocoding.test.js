require("../tests/setupEnv");

jest.mock("../ai/controller", () => ({
  AiUnavailableError: class extends Error {},
  getAutoReply: jest.fn().mockResolvedValue("Mocked."),
}));

const app = require("../server");
const { query } = require("../db");
const { resetDb } = require("./dbReset");

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
});

const { geocode, normalizeKey } = require("../services/geocodingService");

describe("geocoding", () => {
  test("normalizes lookup keys so trivial formatting differences share a cache entry", () => {
    expect(normalizeKey("Kamppi,  Helsinki ")).toBe(normalizeKey("kamppi, Helsinki"));
  });

  test("resolves a known area from the local table by default", async () => {
    const result = await geocode({ area: "Kamppi", city: "Helsinki" });
    expect(result).not.toBeNull();
    expect(result.lat).toBeCloseTo(60.16, 1);
    expect(result.lng).toBeCloseTo(24.93, 1);
  });

  test("the second lookup is served from cache, not recomputed", async () => {
    await geocode({ area: "Kallio", city: "Helsinki" });
    const second = await geocode({ area: "Kallio", city: "Helsinki" });
    expect(second.source).toBe("cache");
  });

  // Without negative caching, an unmappable address hits the provider on
  // every request forever - the worst case for rate limits and cost.
  test("a miss is cached too, so it isn't retried endlessly", async () => {
    const first = await geocode({ area: "Nowhereville", city: "Atlantis" });
    expect(first).toBeNull();

    const { rows } = await query(
      "SELECT found FROM geocode_cache WHERE query_key = $1",
      [normalizeKey("Nowhereville, Atlantis, Finland")]
    );
    expect(rows[0]).toBeDefined();
    expect(rows[0].found).toBe(false);

    // And it stays null on the second call rather than throwing.
    expect(await geocode({ area: "Nowhereville", city: "Atlantis" })).toBeNull();
  });

  test("cache entries record which provider produced them", async () => {
    await geocode({ area: "Toolo", city: "Helsinki" });
    const { rows } = await query(
      "SELECT provider FROM geocode_cache WHERE query_key = $1",
      [normalizeKey("Toolo, Helsinki, Finland")]
    );
    expect(rows[0].provider).toBe("table");
  });
});

// The remote providers are exercised against a mocked fetch: this sandbox
// can't reach Nominatim or Google, and a test that silently skipped would
// be worse than one that states what it covers.
describe("remote geocoding providers (mocked transport)", () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  test("a provider outage falls back to the local table rather than failing the listing", async () => {
    jest.resetModules();
    process.env.GEOCODER = "nominatim";
    global.fetch = jest.fn().mockRejectedValue(new Error("network down"));

    const { geocode: geocodeWithProvider } = require("../services/geocodingService");
    // Deliberately an area NOT geocoded earlier in this file: a cached
    // entry short-circuits before the provider is ever called, so reusing
    // one would test the cache rather than the fallback.
    const result = await geocodeWithProvider({ area: "Malmi", city: "Helsinki" });

    // A slightly approximate coordinate beats a listing that can't be
    // created because a third party is down.
    expect(result).not.toBeNull();
    expect(result.source).toBe("table-fallback");

    delete process.env.GEOCODER;
    jest.resetModules();
  });

  test("a provider failure is NOT cached, so an outage doesn't become permanent", async () => {
    jest.resetModules();
    process.env.GEOCODER = "nominatim";
    global.fetch = jest.fn().mockRejectedValue(new Error("network down"));

    const { geocode: geocodeWithProvider, normalizeKey: nk } = require("../services/geocodingService");
    await geocodeWithProvider({ area: "Transient", city: "Espoo" });

    const { rows } = await query(
      "SELECT * FROM geocode_cache WHERE query_key = $1",
      [nk("Transient, Espoo, Finland")]
    );
    expect(rows).toHaveLength(0);

    delete process.env.GEOCODER;
    jest.resetModules();
  });

  test("a successful remote lookup is parsed and cached", async () => {
    jest.resetModules();
    process.env.GEOCODER = "nominatim";
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ([{ lat: "60.1699", lon: "24.9384", display_name: "Helsinki, Finland", address: { country_code: "fi" } }]),
    });

    const { geocode: geocodeWithProvider } = require("../services/geocodingService");
    const result = await geocodeWithProvider({ area: "Senate Square", city: "Helsinki" });

    expect(result.lat).toBeCloseTo(60.1699, 3);
    expect(result.lng).toBeCloseTo(24.9384, 3);
    expect(result.source).toBe("nominatim");

    delete process.env.GEOCODER;
    jest.resetModules();
  });

  test("identifies itself in the User-Agent, which Nominatim's policy requires", async () => {
    jest.resetModules();
    process.env.GEOCODER = "nominatim";
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => [] });
    global.fetch = fetchMock;

    const { geocode: geocodeWithProvider } = require("../services/geocodingService");
    await geocodeWithProvider({ area: "Somewhere", city: "Helsinki" });

    expect(fetchMock).toHaveBeenCalled();
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["User-Agent"]).toBeTruthy();

    delete process.env.GEOCODER;
    jest.resetModules();
  });
});
