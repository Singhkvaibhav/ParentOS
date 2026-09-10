-- Lets reconciliation report a PaymentIntent that exists at Stripe with no
-- local transaction row.
--
-- Checkout reserves the listing, calls Stripe, then writes the transaction.
-- That is three steps across two systems, and the middle one can succeed
-- while the process dies before the third completes. The result is money
-- authorized at Stripe that this database has never heard of.
--
-- Existing reconciliation walks transactions and asks Stripe about each
-- one, so it can only find problems with rows that EXIST. An orphaned
-- PaymentIntent has no row to walk from - which makes it precisely the
-- failure the current checkout design can produce, and the one the
-- monitoring could not see.
ALTER TABLE reconciliation_issues DROP CONSTRAINT IF EXISTS reconciliation_issues_issue_type_check;
ALTER TABLE reconciliation_issues ADD CONSTRAINT reconciliation_issues_issue_type_check CHECK (issue_type IN (
  'stripe_succeeded_db_pending',
  'stripe_failed_db_paid',
  'stripe_missing',
  'amount_mismatch',
  'stripe_refunded_db_active',
  -- Stripe holds a PaymentIntent this database has no record of.
  'orphaned_payment_intent'
));

-- transaction_id is NULL for an orphan, and the existing unique index keys
-- on it. NULL is never equal to NULL in SQL, so that index would let every
-- reconciliation pass insert another copy of the same orphan. Key those
-- rows on the PaymentIntent id instead.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reconciliation_open_orphan
  ON reconciliation_issues(stripe_payment_intent_id)
  WHERE status = 'open' AND transaction_id IS NULL;
