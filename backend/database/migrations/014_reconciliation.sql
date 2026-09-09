-- (#9) Stripe reconciliation.
--
-- The webhook is the only thing that moves a transaction from 'pending' to
-- 'paid'. Webhooks are delivered at-least-once but not guaranteed-once:
-- they can be delayed, dropped while the server is redeploying, or
-- silently rejected if a signature check fails. Nothing currently notices
-- when that happens.
--
-- The result is a class of bug that is invisible until a customer
-- complains: Stripe says the payment succeeded, the database still says
-- 'pending', the listing stays reserved and then expires, and the buyer
-- has been charged for something they never received. The inverse also
-- matters - a database row marked 'paid' whose PaymentIntent actually
-- failed means goods handed over for money that never arrived.
--
-- This table records discrepancies found by comparing the two systems, so
-- they can be reviewed and resolved rather than discovered by accident.
CREATE TABLE IF NOT EXISTS reconciliation_issues (
  id SERIAL PRIMARY KEY,
  transaction_id INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
  stripe_payment_intent_id TEXT,

  issue_type TEXT NOT NULL CHECK (issue_type IN (
    'stripe_succeeded_db_pending',   -- money taken, order not settled: buyer is out of pocket
    'stripe_failed_db_paid',         -- order settled, money not taken: seller is out of pocket
    'stripe_missing',                -- DB references a PaymentIntent Stripe doesn't know about
    'amount_mismatch',               -- the two systems disagree on how much
    'stripe_refunded_db_active'      -- refunded at Stripe but the order still looks live here
  )),

  db_status TEXT,
  stripe_status TEXT,
  db_amount_cents INTEGER,
  stripe_amount_cents INTEGER,
  detail TEXT,

  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolution_note TEXT,
  resolved_at TIMESTAMPTZ,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One OPEN issue per transaction per type: reconciliation runs repeatedly,
-- and re-reporting the same unresolved discrepancy every pass would bury
-- new problems under duplicates. A repeat sighting bumps last_seen_at
-- instead, which also shows how long something has been broken.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reconciliation_open_unique
  ON reconciliation_issues(transaction_id, issue_type) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_reconciliation_status
  ON reconciliation_issues(status, first_seen_at DESC);

-- Records each pass so it's possible to tell "no problems found" apart
-- from "reconciliation hasn't run in a week", which look identical if you
-- only store the issues.
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id SERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  transactions_checked INTEGER NOT NULL DEFAULT 0,
  issues_found INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
