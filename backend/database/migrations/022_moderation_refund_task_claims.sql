-- Make moderation refund task claiming durable across workers.
--
-- A task must be atomically moved from pending -> processing before a
-- worker calls Stripe. This prevents two workers from executing the same
-- task after a SELECT ... FOR UPDATE SKIP LOCKED lock has been released.

ALTER TABLE moderation_refund_tasks
  DROP CONSTRAINT IF EXISTS moderation_refund_tasks_state_check;

ALTER TABLE moderation_refund_tasks
  ADD CONSTRAINT moderation_refund_tasks_state_check
  CHECK (state IN ('pending', 'processing', 'succeeded', 'failed'));

ALTER TABLE moderation_refund_tasks
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_moderation_tasks_processing
  ON moderation_refund_tasks(state, started_at)
  WHERE state = 'processing';
