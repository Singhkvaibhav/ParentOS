-- P0 #2: a real transaction lifecycle.
--
-- The previous statuses conflated "money taken" with "goods handed over"
-- and had no representation for a contested order at all:
--   pending -> paid -> completed, plus cancelled/refunded/expired
--
-- The new lifecycle separates the two things that can independently go
-- wrong:
--   pending    - checkout started, payment not settled
--   paid       - money captured, item NOT yet handed over
--   fulfilled  - seller says they handed it over
--   completed  - buyer confirms receipt; the deal is done
-- plus the terminal/exceptional states:
--   cancelled  - never paid (payment failed or abandoned)
--   expired    - reservation timed out before payment settled
--   refunded   - money returned
--   disputed   - buyer and seller disagree; needs a human
--
-- 'fulfilled' is the genuinely new step. Previously a seller had no way to
-- say "I've sent this", so a buyer who hadn't confirmed receipt was
-- indistinguishable from one where the seller had done nothing - which is
-- exactly the ambiguity a dispute needs to resolve.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_status_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_status_check CHECK (status IN (
  'pending',
  'paid',
  'fulfilled',
  'completed',
  'cancelled',
  'expired',
  'refunded',
  'disputed'
));

-- Timestamps for each transition. Without these there's no way to answer
-- "how long do sellers take to hand over?" or to auto-resolve stale
-- orders, and a dispute has no timeline to reason about.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS fulfilled_at TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS disputed_at TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS dispute_reason TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

-- Backfill paid_at for existing settled orders so the timeline isn't full
-- of holes for anything that traded before this migration.
UPDATE transactions SET paid_at = created_at
  WHERE paid_at IS NULL AND status IN ('paid', 'completed', 'refunded');
UPDATE transactions SET completed_at = created_at
  WHERE completed_at IS NULL AND status = 'completed';

CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status, created_at DESC);

-- New notification types for the added lifecycle steps.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'message_received',
  'item_sold',
  'purchase_confirmed',
  'review_received',
  'listing_taken_down',
  'order_completed',
  'order_fulfilled',
  'order_disputed',
  'order_cancelled'
));
