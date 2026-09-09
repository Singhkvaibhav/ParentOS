-- Makes moderation-vs-payments recoverable instead of best-effort.
--
-- The previous takedown did this:
--   1. UPDATE listings SET moderated_at = now()
--   2. call Stripe to cancel/refund each affected order
-- outside any transaction, catching individual refund failures so one bad
-- order didn't block the rest. That is the right instinct and the wrong
-- outcome: the system could legitimately come to rest at
--   listing = moderated, transaction = paid, Stripe = money still captured
-- with nothing recording that money was owed, and nothing to retry it.
--
-- Wrapping both in one database transaction does NOT fix this. Stripe is a
-- separate system; a DB transaction cannot roll back a refund that already
-- happened, and holding a transaction open across a network call to a
-- payment provider is its own problem. Two systems cannot be made atomic.
--
-- So the intermediate states become explicit and durable instead. A
-- takedown is now a saga: the database records the INTENT and one task per
-- affected order atomically, then those tasks are executed against Stripe
-- and their results recorded. A crash at any point leaves a row that says
-- what still has to happen.

-- Tracks one takedown attempt through to completion.
CREATE TABLE IF NOT EXISTS moderation_actions (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,

  -- requested        - listing hidden, refund tasks recorded, none run yet
  -- settling         - tasks are being worked through
  -- finalized        - every affected order resolved; the takedown is complete
  -- needs_attention  - at least one task exhausted its retries; a human
  --                    must intervene. Deliberately NOT a silent end state.
  state TEXT NOT NULL DEFAULT 'requested'
    CHECK (state IN ('requested', 'settling', 'finalized', 'needs_attention')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_moderation_actions_open
  ON moderation_actions(state, created_at) WHERE state <> 'finalized';

-- The outbox: one row per order that must be resolved before the takedown
-- can be considered complete. Written in the SAME transaction as the
-- listing being hidden, so the obligation can never be lost - if the
-- process dies immediately after, the work is still recorded.
CREATE TABLE IF NOT EXISTS moderation_refund_tasks (
  id SERIAL PRIMARY KEY,
  moderation_action_id INTEGER NOT NULL REFERENCES moderation_actions(id) ON DELETE CASCADE,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,

  -- 'cancel' for a PaymentIntent that never captured, 'refund' for money
  -- already taken. Decided when the task is written, from the status the
  -- order had at that moment.
  operation TEXT NOT NULL CHECK (operation IN ('cancel', 'refund')),

  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'succeeded', 'failed')),

  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,

  -- Sent to Stripe as the idempotency key. Stripe deduplicates on it, so a
  -- retry after an ambiguous timeout cannot refund the same buyer twice -
  -- which is the failure a naive retry loop would introduce while trying
  -- to fix a different one.
  idempotency_key TEXT NOT NULL,

  stripe_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,

  -- One task per order per action: re-running the drain must not create
  -- duplicate obligations.
  UNIQUE (moderation_action_id, transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_moderation_tasks_pending
  ON moderation_refund_tasks(state, created_at) WHERE state = 'pending';

-- Distinguishes "hidden, money still being resolved" from "hidden and
-- fully settled". The listing is hidden IMMEDIATELY either way: an unsafe
-- car seat must stop being purchasable the instant a moderator says so,
-- and making that wait on a payment provider would be the wrong trade.
-- What waits for money is FINALIZATION, not concealment.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS moderation_state TEXT
  CHECK (moderation_state IS NULL OR moderation_state IN ('pending', 'finalized'));
