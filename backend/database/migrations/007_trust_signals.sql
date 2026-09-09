-- P2 #19: seller/buyer trust signals.
--
-- The pieces existed (reviews, a verified flag, Connect onboarding) but
-- nothing combined them, and none of it appeared where buyers actually
-- decide: the listing card and the seller's profile.
--
-- Counters are materialized rather than computed on every read. Completed
-- sales in particular would otherwise mean a JOIN against transactions on
-- every listing card render, which is exactly the N+1 shape earlier rounds
-- worked to remove.
ALTER TABLE users ADD COLUMN IF NOT EXISTS completed_sales_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS completed_purchases_count INTEGER NOT NULL DEFAULT 0;

-- Cached review aggregates. Recomputed on write (a review is rare relative
-- to a profile view), so reads never have to AVG() over the reviews table.
ALTER TABLE users ADD COLUMN IF NOT EXISTS rating_sum INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rating_count INTEGER NOT NULL DEFAULT 0;

-- Backfill from existing data so the counters are correct for anyone who
-- already traded before this migration - otherwise established sellers
-- would suddenly look brand new.
UPDATE users u SET
  completed_sales_count = COALESCE((
    SELECT COUNT(*) FROM transactions t
    WHERE t.seller_id = u.id AND t.status IN ('paid', 'completed')
  ), 0),
  completed_purchases_count = COALESCE((
    SELECT COUNT(*) FROM transactions t
    WHERE t.buyer_id = u.id AND t.status IN ('paid', 'completed')
  ), 0),
  rating_sum = COALESCE((SELECT SUM(rating) FROM reviews r WHERE r.reviewee_id = u.id), 0),
  rating_count = COALESCE((SELECT COUNT(*) FROM reviews r WHERE r.reviewee_id = u.id), 0);

CREATE INDEX IF NOT EXISTS idx_users_trust ON users(completed_sales_count DESC, rating_count DESC);
