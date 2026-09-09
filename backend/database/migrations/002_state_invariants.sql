-- P0 hardening: push state-consistency guarantees down into the database,
-- so they hold even if application logic has a bug or a new code path
-- forgets to check something.

-- (#4) One transaction per Stripe PaymentIntent. Without this, a retried
-- checkout or a bug could create two transaction rows pointing at the same
-- payment, and the webhook's "SELECT ... WHERE stripe_payment_intent_id"
-- would silently pick whichever one came back first - settling one and
-- leaving the other dangling as 'pending' forever.
-- Partial index (WHERE NOT NULL) because the column is nullable in
-- principle; NULLs don't conflict in Postgres anyway, but being explicit
-- documents the intent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_payment_intent_unique
  ON transactions(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

-- (#3) At most one unresolved (pending) transaction per listing. Two
-- concurrent buyers can't both hold a live checkout on the same item -
-- the atomic active->reserved claim in checkout() already prevents this
-- in application code, but this makes it impossible at the storage layer
-- regardless of how checkout is called.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_one_pending_per_listing
  ON transactions(listing_id)
  WHERE status = 'pending';

-- (#3) A reserved listing must have a reservation timestamp, and a listing
-- that isn't reserved must not - otherwise the expiry sweep either can't
-- see a stuck reservation (no timestamp) or wrongly considers a live
-- listing expired (stale timestamp). This invariant is what makes the
-- sweep's correctness a property of the data, not just of the code paths
-- that happen to set it.
ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_reserved_at_matches_status;
ALTER TABLE listings ADD CONSTRAINT listings_reserved_at_matches_status
  CHECK (
    (status = 'reserved' AND reserved_at IS NOT NULL) OR
    (status <> 'reserved' AND reserved_at IS NULL)
  );

-- (#2) One conversation per (listing, buyer) pair. This UNIQUE already
-- existed in 001, but it's what makes the concurrent-creation fix work:
-- the ON CONFLICT DO NOTHING / re-SELECT retry in messagesService relies
-- on the database rejecting the duplicate rather than on a check-then-act
-- in application code that two requests can both pass.
-- (No-op if already present; listed here so the invariant is discoverable
-- alongside the others it works with.)
