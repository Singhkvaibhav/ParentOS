const { query } = require("../db");
const { findArea } = require("../areaData");
const logger = require("../logger");

// (#14) Address -> coordinates, with the hand-maintained table demoted to
// a fallback rather than being the only source.
//
// Provider is selectable so expansion doesn't mean rewriting this:
//   GEOCODER=table      the existing hardcoded neighbourhoods (default)
//   GEOCODER=nominatim  OpenStreetMap - free, but 1 req/sec and requires
//                       a real User-Agent identifying the application
//   GEOCODER=google     paid, higher quality, needs GOOGLE_MAPS_API_KEY
//
// The default is deliberately 'table': switching to a network provider
// changes the app's failure modes (rate limits, latency, outages, cost)
// and shouldn't happen implicitly just because someone deployed.

const PROVIDER = process.env.GEOCODER || "table";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const REQUEST_TIMEOUT_MS = 5000;

function normalizeKey(q) {
  return String(q).trim().toLowerCase().replace(/\s+/g, " ");
}

// --- Cache ----------------------------------------------------------------

async function readCache(key) {
  const { rows } = await query("SELECT * FROM geocode_cache WHERE query_key = $1", [key]);
  if (!rows[0]) return null;

  // Touch asynchronously - a cache read shouldn't wait on a write, and if
  // the touch fails the cached answer is still perfectly good.
  query("UPDATE geocode_cache SET last_used_at = now() WHERE id = $1", [rows[0].id]).catch(() => {});
  return rows[0];
}

async function writeCache(key, original, result, provider) {
  await query(
    `INSERT INTO geocode_cache (query_key, original_query, lat, lng, display_name, country_code, provider, found)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (query_key) DO UPDATE SET
       lat = EXCLUDED.lat, lng = EXCLUDED.lng, display_name = EXCLUDED.display_name,
       country_code = EXCLUDED.country_code, provider = EXCLUDED.provider,
       found = EXCLUDED.found, last_used_at = now()`,
    [
      key, original,
      result?.lat ?? null, result?.lng ?? null,
      result?.displayName ?? null, result?.countryCode ?? null,
      provider, !!result,
    ]
  );
}

// --- Providers ------------------------------------------------------------

// The existing hand-maintained lookup. Kept as a provider rather than
// deleted: it needs no network, so it's the right default for development
// and a genuine safety net when a remote provider is down.
function geocodeFromTable(area, city) {
  const entry = findArea(city, area);
  if (!entry) return null;
  return {
    lat: entry.lat,
    lng: entry.lng,
    displayName: `${entry.area}, ${city}`,
    countryCode: "fi",
  };
}

async function geocodeWithNominatim(queryString) {
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(queryString)}&format=json&limit=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      // Nominatim's usage policy requires identifying the application;
      // anonymous traffic gets blocked.
      headers: { "User-Agent": process.env.GEOCODER_USER_AGENT || "ParentOS/1.0 (marketplace)" },
    });
    if (!res.ok) throw new Error(`Nominatim returned ${res.status}`);

    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    return {
      lat: Number(data[0].lat),
      lng: Number(data[0].lon),
      displayName: data[0].display_name,
      countryCode: data[0].address?.country_code || null,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function geocodeWithGoogle(queryString) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error("GOOGLE_MAPS_API_KEY is not set");

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(queryString)}&key=${key}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    const data = await res.json();
    if (data.status !== "OK" || !data.results?.length) return null;
    const best = data.results[0];
    return {
      lat: best.geometry.location.lat,
      lng: best.geometry.location.lng,
      displayName: best.formatted_address,
      countryCode: best.address_components?.find((c) => c.types.includes("country"))?.short_name?.toLowerCase() || null,
    };
  } finally {
    clearTimeout(timer);
  }
}

// --- Public API -----------------------------------------------------------

// Resolves an area/city to coordinates. Cache first, then the configured
// provider, then the local table.
//
// Falling back to the table on provider failure is deliberate: a listing
// with slightly approximate coordinates is far better than a listing that
// can't be created because a third-party geocoder is having an outage.
async function geocode({ area, city }) {
  const queryString = [area, city, "Finland"].filter(Boolean).join(", ");
  const key = normalizeKey(queryString);

  const cached = await readCache(key);
  if (cached) {
    if (!cached.found) return null; // negative result, cached on purpose
    return { lat: cached.lat, lng: cached.lng, displayName: cached.display_name, source: "cache" };
  }

  if (PROVIDER === "table") {
    const result = geocodeFromTable(area, city);
    await writeCache(key, queryString, result, "table").catch(() => {});
    return result ? { ...result, source: "table" } : null;
  }

  try {
    const result = PROVIDER === "google"
      ? await geocodeWithGoogle(queryString)
      : await geocodeWithNominatim(queryString);

    await writeCache(key, queryString, result, PROVIDER).catch(() => {});
    return result ? { ...result, source: PROVIDER } : null;
  } catch (e) {
    logger.warn("geocode_provider_failed", { provider: PROVIDER, queryString, err: e });

    // Do NOT cache a provider failure - it says nothing about whether the
    // address is real, and caching it would make a transient outage
    // permanent for that address.
    const fallback = geocodeFromTable(area, city);
    return fallback ? { ...fallback, source: "table-fallback" } : null;
  }
}

module.exports = { geocode, normalizeKey, PROVIDER };
