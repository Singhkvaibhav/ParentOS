-- Migration 021: listing subcategories (Stage 1 of the category redesign).
--
-- The category menu the frontend wants to offer (Clothes > Baby/Girls/
-- Outerwear/..., Accessories > Shoes/Hats/..., Toys > Baby toys/
-- Educational/...) is one level deeper than the three top-level
-- categories this schema currently understands. Rather than build that
-- richer menu against categories the backend can't validate - which would
-- let the UI offer combinations ("Baby gear > Car seats") that don't
-- exist as data - this adds one column, nullable, scoped to the existing
-- three categories. A wider top-level taxonomy (Baby gear, Furniture,
-- Feeding, ...) is real future work, not something to fake in the UI now.
--
-- Nullable rather than backfilled: no subcategory value is more correct
-- than another for the ~listings that predate this column, and forcing a
-- guess into every existing row would misclassify all of them just to
-- avoid a NULL.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS subcategory TEXT;

-- Enforced narrowly (fixed strings, not "any non-null category has some
-- subcategory") rather than joining out to a table, matching how category
-- and condition are already validated against an in-code vocabulary in
-- config.js instead of a lookup table - see config.js's SUBCATEGORIES.
ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_subcategory_check;
ALTER TABLE listings ADD CONSTRAINT listings_subcategory_check CHECK (
  subcategory IS NULL OR (
    (category = 'clothes' AND subcategory IN (
      'baby', 'girls', 'boys', 'outerwear', 'tops', 'trousers', 'dresses', 'sleepwear', 'clothing-bundles'
    )) OR
    (category = 'accessories' AND subcategory IN (
      'shoes', 'hats', 'bags', 'other-accessories'
    )) OR
    (category = 'toys' AND subcategory IN (
      'baby-toys', 'educational', 'games-puzzles', 'outdoor-toys', 'soft-toys'
    ))
  )
);

-- Browsing filters by category alone or by category+subcategory - a
-- composite index with category leading serves both, making the
-- category-only index from migration 001 redundant.
DROP INDEX IF EXISTS idx_listings_category;
CREATE INDEX IF NOT EXISTS idx_listings_category_subcategory ON listings(category, subcategory);
