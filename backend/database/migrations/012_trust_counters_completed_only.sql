-- Fixes a trust-integrity bug: completed_sales_count / completed_purchases_count
-- were counting PAID orders, not COMPLETED ones.
--
-- Two separate sources of the error, both repaired here:
--   1. The webhook incremented the counters the moment Stripe confirmed
--      payment, before the item was handed over or the buyer confirmed it.
--   2. The 007 backfill counted `status IN ('paid', 'completed')`.
--
-- The consequence was that a seller who took payment and shipped nothing
-- still accrued "completed sales" on their public trust badge - and could
-- reach the 'active' badge level purely on orders that never concluded.
-- That is precisely the situation a buyer consults the badge to avoid, so
-- the counter was actively misleading in the one case it most mattered.
--
-- Recomputed from source rather than adjusted, so any drift from either
-- cause is corrected in one pass regardless of how it accumulated.
UPDATE users u SET
  completed_sales_count = COALESCE((
    SELECT COUNT(*) FROM transactions t WHERE t.seller_id = u.id AND t.status = 'completed'
  ), 0),
  completed_purchases_count = COALESCE((
    SELECT COUNT(*) FROM transactions t WHERE t.buyer_id = u.id AND t.status = 'completed'
  ), 0);

-- Supports the recompute, which now runs on every completion and dispute.
CREATE INDEX IF NOT EXISTS idx_transactions_seller_completed
  ON transactions(seller_id) WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS idx_transactions_buyer_completed
  ON transactions(buyer_id) WHERE status = 'completed';
