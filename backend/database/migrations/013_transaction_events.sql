-- #11: an append-only audit trail for every order state change.
--
-- The transactions table records where an order IS. It says nothing about
-- how it got there - who acted, when, or why. For a marketplace handling
-- money that gap shows up exactly when it hurts most: a buyer disputes a
-- charge and support has one status field and no timeline.
--
-- Answering "the seller marked this fulfilled at 09:35, the buyer disputed
-- it at 12:44" needs history, not state.
CREATE TABLE IF NOT EXISTS transaction_events (
  id BIGSERIAL PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,

  event_type TEXT NOT NULL,
  from_status TEXT,           -- NULL for the creation event
  to_status TEXT NOT NULL,

  -- Who caused it. NULL means the system acted with no human involved -
  -- a Stripe webhook, the expiry sweep - which is itself worth recording,
  -- since "nobody did this, a timer did" is a real answer in a dispute.
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('buyer', 'seller', 'admin', 'system')),

  reason TEXT,
  -- Free-form context (Stripe ids, refund ids, moderation reference).
  -- JSONB rather than columns because the useful fields differ per event
  -- type and inventing a column per case would be mostly-NULL noise.
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The dominant read is "show me this order's history, oldest first".
CREATE INDEX IF NOT EXISTS idx_transaction_events_transaction
  ON transaction_events(transaction_id, id);
-- Supports "what happened across the platform in this window" for
-- investigating a fraud pattern or a spike.
CREATE INDEX IF NOT EXISTS idx_transaction_events_time
  ON transaction_events(created_at DESC);

-- Seed history for orders that predate this table, so an existing order
-- doesn't look like it materialised out of nowhere. Only the facts we can
-- actually evidence from the timestamp columns are backfilled - inventing
-- plausible intermediate events would poison the audit trail it exists to
-- provide.
INSERT INTO transaction_events (transaction_id, event_type, from_status, to_status, actor_type, reason, created_at)
SELECT id, 'order_created', NULL, 'pending', 'system', 'Backfilled from existing data', created_at
FROM transactions;

INSERT INTO transaction_events (transaction_id, event_type, from_status, to_status, actor_type, reason, created_at)
SELECT id, 'payment_settled', 'pending', 'paid', 'system', 'Backfilled from existing data', paid_at
FROM transactions WHERE paid_at IS NOT NULL;

INSERT INTO transaction_events (transaction_id, event_type, from_status, to_status, actor_type, reason, created_at)
SELECT id, 'order_fulfilled', 'paid', 'fulfilled', 'seller', 'Backfilled from existing data', fulfilled_at
FROM transactions WHERE fulfilled_at IS NOT NULL;

INSERT INTO transaction_events (transaction_id, event_type, from_status, to_status, actor_type, reason, created_at)
SELECT id, 'receipt_confirmed',
       CASE WHEN fulfilled_at IS NOT NULL THEN 'fulfilled' ELSE 'paid' END,
       'completed', 'buyer', 'Backfilled from existing data', completed_at
FROM transactions WHERE completed_at IS NOT NULL;

INSERT INTO transaction_events (transaction_id, event_type, from_status, to_status, actor_type, reason, created_at)
SELECT id, 'dispute_raised', NULL, 'disputed', 'system', 'Backfilled from existing data', disputed_at
FROM transactions WHERE disputed_at IS NOT NULL;
