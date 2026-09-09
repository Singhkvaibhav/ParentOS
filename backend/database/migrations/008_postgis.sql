-- P2 #15: PostGIS geospatial search.
--
-- Distance search currently does a lat/lng bounding-box prefilter in SQL,
-- then computes exact Haversine distance and sorts in JavaScript. That was
-- the right call while the catalogue was small - but it means every
-- distance-filtered query pulls the whole bounding box into Node, and
-- pagination has to happen after the sort rather than in the database.
--
-- PostGIS moves both the distance calculation and the ordering into the
-- query, so the database returns exactly the page asked for.
--
-- This migration is written to be SAFE TO RUN WITHOUT POSTGIS: if the
-- extension isn't available (a managed database that doesn't offer it, a
-- developer's local machine), it logs a notice and does nothing, and the
-- application falls back to the existing bounding-box + JS path. That
-- fallback is deliberate - requiring PostGIS to run the app at all would
-- make it much harder to deploy for no benefit at small scale.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'postgis') THEN
    CREATE EXTENSION IF NOT EXISTS postgis;

    -- geography(Point) rather than geometry: geography computes distances
    -- on the spheroid in metres, which is what "within 5 km" actually
    -- means. geometry would need an appropriate projection to avoid
    -- distortion, and Finland is far enough north for that to matter.
    ALTER TABLE listings ADD COLUMN IF NOT EXISTS geog geography(Point, 4326)
      GENERATED ALWAYS AS (
        CASE
          WHEN lat IS NOT NULL AND lng IS NOT NULL
          THEN ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography
        END
      ) STORED;

    -- GiST is the index type for spatial data; this is what makes
    -- ST_DWithin an index lookup rather than a scan.
    CREATE INDEX IF NOT EXISTS idx_listings_geog ON listings USING GIST (geog);

    RAISE NOTICE 'PostGIS enabled - distance search will use spatial indexing.';
  ELSE
    RAISE NOTICE 'PostGIS not available - distance search will use the bounding-box fallback.';
  END IF;
END
$$;
