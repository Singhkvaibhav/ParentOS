-- (#14) Geocoding cache.
--
-- Location currently comes from a hand-maintained table of ~13 Helsinki
-- neighbourhoods with approximate coordinates, kept in sync by hand
-- between backend/areaData.js and the frontend. That was fine for one
-- city. It does not survive Espoo, Vantaa, Turku, Tampere, Stockholm -
-- each expansion means hand-entering coordinates and keeping two files
-- aligned, and the coordinates are approximate enough that "within 2 km"
-- is already a rough claim.
--
-- Real geocoding replaces that, but introduces two problems this table
-- solves: providers rate-limit aggressively (Nominatim's policy is 1
-- request/second) and they cost money per lookup at volume. Addresses
-- also repeat constantly - a neighbourhood is geocoded once and reused by
-- every listing in it.
CREATE TABLE IF NOT EXISTS geocode_cache (
  id SERIAL PRIMARY KEY,
  -- Normalized lookup key (lowercased, whitespace collapsed), so
  -- "Kamppi, Helsinki" and "kamppi,  helsinki" share one entry.
  query_key TEXT NOT NULL UNIQUE,
  original_query TEXT NOT NULL,

  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  display_name TEXT,
  country_code TEXT,
  provider TEXT NOT NULL,

  -- A negative result is cached too. Without this, an unmappable address
  -- would hit the provider on every single request forever - the worst
  -- case for both rate limits and cost.
  found BOOLEAN NOT NULL DEFAULT true,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_geocode_cache_last_used ON geocode_cache(last_used_at);
