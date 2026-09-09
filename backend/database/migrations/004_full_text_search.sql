-- P2 #16: real full-text search.
--
-- Search was `title ILIKE '%term%' OR description ILIKE '%term%'`. A
-- leading wildcard makes a B-tree index unusable, so every search was a
-- sequential scan over every active listing. It also can't match on word
-- stems ("bike" doesn't find "bikes") or rank results by relevance.
--
-- A generated tsvector column keeps the searchable text materialized and
-- in sync automatically (Postgres recomputes it on write), and a GIN index
-- over it makes matching genuinely indexed.
--
-- Language note: this uses the 'simple' configuration rather than
-- 'english', because the catalogue is Finnish-market and mixes Finnish,
-- Swedish and English text. 'simple' does no language-specific stemming -
-- it lowercases and splits on word boundaries, which degrades gracefully
-- across languages instead of stemming one correctly and mangling the
-- others. Revisit if the catalogue becomes predominantly one language.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(description, '')), 'B')
  ) STORED;

-- GIN is the right index type for tsvector: built for "which rows contain
-- this term" lookups, which is exactly the query shape here.
CREATE INDEX IF NOT EXISTS idx_listings_search_vector ON listings USING GIN (search_vector);

-- Title matches outrank description matches (the setweight 'A'/'B' above),
-- so someone searching "stroller" gets listings actually titled stroller
-- before ones that merely mention the word in passing.
