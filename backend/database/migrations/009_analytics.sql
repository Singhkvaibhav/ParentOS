-- P2 #21: analytics.
--
-- Most marketplace questions are already answerable from existing tables -
-- listings, transactions, conversations, reviews and users between them
-- cover supply, demand, conversion and retention. Rather than bolting on
-- a generic event-tracking system that duplicates all of that, this adds
-- only the one signal genuinely missing: how often a listing is VIEWED.
--
-- Without views there's no denominator. "12 sales" is unanchored; "12
-- sales from 400 views" is a conversion rate you can act on, and a seller
-- can tell "nobody is finding this" apart from "people look and don't
-- buy" - two problems with completely different fixes.

CREATE TABLE IF NOT EXISTS listing_views (
  id BIGSERIAL PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  -- NULL for logged-out visitors: browsing doesn't require an account, and
  -- refusing to count anonymous views would badly understate real demand.
  viewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_listing_views_listing ON listing_views(listing_id, viewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_listing_views_time ON listing_views(viewed_at DESC);

-- Denormalized counter so a seller's dashboard doesn't COUNT(*) over the
-- full history on every render. The raw rows are kept for time-series
-- questions ("views this week vs last") that a single counter can't answer.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS view_count INTEGER NOT NULL DEFAULT 0;

-- Deliberately NOT added: a generic `events` table with a JSON payload.
-- It's tempting and it's how analytics usually starts, but it becomes a
-- dumping ground that's expensive to query and impossible to trust,
-- while the real questions here are answerable from properly-typed rows
-- that already exist. Worth revisiting only when there's a concrete
-- question the current schema genuinely can't answer.
