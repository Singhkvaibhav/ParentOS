const crypto = require("crypto");
const { query, withTransaction } = require("../db");
const { getStripe } = require("../stripeClient");
const { IN_FLIGHT_FOR_MODERATION, sqlList, STATUS } = require("../transactionStatus");
const { notify } = require("./notificationsService");
const { transitionOrder } = require("./orderStateMachine");
const logger = require("../logger");

// Moderation takedown as a saga.
//
// Stripe and Postgres cannot be made atomic, so this doesn't try. It splits
// the takedown into a part that IS atomic (recording what must happen) and
// a part that is merely retryable (making it happen), with durable state
// in between. A crash at any point leaves a row describing the outstanding
// obligation rather than a silently inconsistent world.
//
//   requestTakedown()   one DB transaction: hide the listing, create the
//                       action, write one refund task per affected order
//   drainTasks()        execute tasks against Stripe, recording each result
//                       in its own transaction
//   finalize            when every task has succeeded
//
// The listing is hidden in step one and never waits for step two. An unsafe
// item must stop being purchasable immediately; only FINALIZATION waits for
// money to settle.

const MAX_ATTEMPTS = 5;

class ModerationSagaError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// --- Step 1: atomic intent -------------------------------------------------

async function requestTakedown({ listingId, adminId, reason }) {
  return withTransaction(async (tx) => {
    // Lock the listing so two moderators acting at once can't both create
    // an action and double-refund the same orders.
    const { rows: listingRows } = await tx(
      "SELECT id, seller_id, title, moderated_at FROM listings WHERE id = $1 FOR UPDATE",
      [listingId]
    );
    const listing = listingRows[0];
    if (!listing) throw new ModerationSagaError(404, "Listing not found.");
    if (listing.moderated_at) throw new ModerationSagaError(409, "This listing is already taken down.");

    // Hide it now. This is the safety-critical half and it must not depend
    // on a payment provider being reachable.
    await tx(
      `UPDATE listings
       SET moderated_at = now(), moderation_reason = $1, moderation_state = 'pending'
       WHERE id = $2`,
      [reason || "Removed by moderator", listingId]
    );

    const { rows: actionRows } = await tx(
      `INSERT INTO moderation_actions (listing_id, admin_id, reason, state)
       VALUES ($1, $2, $3, 'requested') RETURNING *`,
      [listingId, adminId, reason || null]
    );
    const action = actionRows[0];

    // Lock the affected orders too, so a webhook can't move one from
    // pending to paid between reading it and deciding cancel-vs-refund.
    const { rows: orders } = await tx(
      `SELECT id, status, buyer_id, stripe_payment_intent_id
       FROM transactions
       WHERE listing_id = $1 AND status IN (${sqlList(IN_FLIGHT_FOR_MODERATION)})
       FOR UPDATE`,
      [listingId]
    );

    for (const order of orders) {
      // A never-captured PaymentIntent is cancelled; captured money is
      // refunded. Refunding an uncaptured intent is an error at Stripe, so
      // the distinction is recorded rather than guessed at execution time.
      const operation = order.status === STATUS.PENDING ? "cancel" : "refund";
      await tx(
        `INSERT INTO moderation_refund_tasks
           (moderation_action_id, transaction_id, operation, idempotency_key)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (moderation_action_id, transaction_id) DO NOTHING`,
        [action.id, order.id, operation, `mod-${action.id}-tx-${order.id}-${crypto.randomUUID()}`]
      );
    }

    logger.warn("moderation_takedown_requested", {
      listingId, adminId, actionId: action.id, affectedOrders: orders.length,
    });

    return { action, taskCount: orders.length, listing };
  });
}

// --- Step 2: execute, one task at a time ----------------------------------

async function executeTask(task, stripe) {
  const { rows } = await query("SELECT * FROM transactions WHERE id = $1", [task.transaction_id]);
  const order = rows[0];
  if (!order) {
    // Nothing to refund; treat as done rather than retrying forever.
    return { ok: true, reference: null, note: "transaction no longer exists" };
  }

  if (!order.stripe_payment_intent_id) {
    return { ok: true, reference: null, note: "no payment intent" };
  }

  // Idempotency key is stored, not generated per attempt: that's what makes
  // a retry after an ambiguous network failure safe. Without it, a timeout
  // on a refund that actually succeeded would refund the buyer twice on the
  // next attempt.
  const options = { idempotencyKey: task.idempotency_key };

  const isCancel = task.operation === "cancel";
  const result = isCancel
    ? await stripe.paymentIntents.cancel(order.stripe_payment_intent_id, {}, options)
    : await stripe.refunds.create({ payment_intent: order.stripe_payment_intent_id }, options);

  // Goes through transitionOrder rather than UPDATE-ing status directly.
  // That function is the single place transitions are validated, timestamped
  // AND written to the audit trail - a raw UPDATE here would move the order
  // while leaving no record of who did it or why, which is exactly what the
  // audit trail exists to prevent. (Caught by an existing test: the refund
  // event lost its admin attribution when this bypassed the state machine.)
  await transitionOrder({
    transactionId: order.id,
    to: isCancel ? STATUS.CANCELLED : STATUS.REFUNDED,
    actorId: task.admin_id ?? null,
    actorType: "admin",
    // Keeps the moderator context AND the specific reason. A buyer
    // reading "Recalled product" alone can't tell whether they were
    // refunded by the seller, the platform, or an automated sweep.
    reason: `Listing removed by moderator${task.reason ? `: ${task.reason}` : ""}`,
    metadata: { moderationActionId: task.moderation_action_id, operation: task.operation },
  });

  return { ok: true, reference: result?.id ?? null };
}

// Works through outstanding tasks. Safe to call repeatedly and from more
// than one process: each task is claimed with SKIP LOCKED so two workers
// never execute the same refund.
async function drainTasks({ actionId = null, limit = 50 } = {}) {
  let stripe;
  try {
    stripe = getStripe();
  } catch {
    // Without Stripe nothing can be settled. Leaving the tasks pending is
    // correct - they describe real obligations and must not be discarded.
    logger.error("moderation_drain_blocked_no_stripe", { actionId });
    return { processed: 0, succeeded: 0, failed: 0, blocked: true };
  }

  // Joined so the audit trail can attribute the refund to the moderator who
  // ordered it, rather than to nobody.
  const { rows: tasks } = await query(
    `WITH claimed AS (
       UPDATE moderation_refund_tasks t
       SET state = 'processing',
           attempts = attempts + 1,
           started_at = now()
       WHERE t.id IN (
         SELECT t2.id
         FROM moderation_refund_tasks t2
         WHERE t2.state = 'pending'
           AND t2.attempts < $1
           ${actionId ? "AND t2.moderation_action_id = $3" : ""}
         ORDER BY t2.created_at ASC
         LIMIT $2
         FOR UPDATE OF t2 SKIP LOCKED
       )
       RETURNING t.*
     )
     SELECT c.*, a.admin_id, a.reason
     FROM claimed c
     JOIN moderation_actions a ON a.id = c.moderation_action_id
     ORDER BY c.created_at ASC`,
    actionId ? [MAX_ATTEMPTS, limit, actionId] : [MAX_ATTEMPTS, limit]
  );

  let succeeded = 0;
  let failed = 0;

  for (const task of tasks) {
    try {
      const result = await executeTask(task, stripe);
      await query(
        `UPDATE moderation_refund_tasks
         SET state = 'succeeded', completed_at = now(), stripe_reference = $1, last_error = NULL
         WHERE id = $2`,
        [result.reference, task.id]
      );
      succeeded += 1;

      const { rows } = await query("SELECT buyer_id, listing_id FROM transactions WHERE id = $1", [task.transaction_id]);
      if (rows[0]) {
        notify({
          userId: rows[0].buyer_id,
          type: "order_cancelled",
          title: "An order was cancelled and refunded",
          body: "The listing was removed by a moderator. Any payment has been returned.",
          listingId: rows[0].listing_id,
        });
      }
    } catch (e) {
      failed += 1;
      const exhausted = task.attempts >= MAX_ATTEMPTS;
      await query(
        `UPDATE moderation_refund_tasks
         SET state = $1, last_error = $2, completed_at = CASE WHEN $1 = 'failed' THEN now() ELSE NULL END
         WHERE id = $3`,
        [exhausted ? "failed" : "pending", String(e?.message || e).slice(0, 1000), task.id]
      );
      logger.error("moderation_refund_task_failed", {
        taskId: task.id, transactionId: task.transaction_id,
        attempts: task.attempts, exhausted, err: e,
      });
    }
  }

  await reconcileActionStates();
  return { processed: tasks.length, succeeded, failed, blocked: false };
}

// --- Step 3: finalize (or escalate) ---------------------------------------

// Moves each open action to its resting state based on its tasks. Derived
// rather than set inline, so an action can't be marked finalized by a code
// path that didn't actually check every task.
async function reconcileActionStates() {
  await query(`
    UPDATE moderation_actions a
    SET state = 'finalized', finalized_at = now()
    WHERE a.state <> 'finalized'
      AND NOT EXISTS (
        SELECT 1 FROM moderation_refund_tasks t
        WHERE t.moderation_action_id = a.id AND t.state <> 'succeeded'
      )
  `);

  // Anything with an exhausted task needs a person, and says so.
  await query(`
    UPDATE moderation_actions a
    SET state = 'needs_attention'
    WHERE a.state NOT IN ('finalized', 'needs_attention')
      AND EXISTS (
        SELECT 1 FROM moderation_refund_tasks t
        WHERE t.moderation_action_id = a.id AND t.state = 'failed'
      )
  `);

  await query(`
    UPDATE moderation_actions a
    SET state = 'settling'
    WHERE a.state = 'requested'
      AND EXISTS (
        SELECT 1 FROM moderation_refund_tasks t
        WHERE t.moderation_action_id = a.id AND t.attempts > 0
      )
  `);

  // The listing's own marker follows its action, so "hidden and settled" is
  // distinguishable from "hidden, money outstanding" without a join.
  await query(`
    UPDATE listings l
    SET moderation_state = 'finalized'
    WHERE l.moderation_state = 'pending'
      AND EXISTS (
        SELECT 1 FROM moderation_actions a
        WHERE a.listing_id = l.id AND a.state = 'finalized'
      )
  `);
}

// --- Visibility -----------------------------------------------------------

// Unfinished moderation is money that may be owed to a buyer, so it must be
// visible rather than sitting silently in a table.
async function listUnsettled() {
  const { rows } = await query(`
    SELECT a.*, l.title AS listing_title,
           COUNT(t.id) FILTER (WHERE t.state = 'pending') AS pending_tasks,
           COUNT(t.id) FILTER (WHERE t.state = 'failed') AS failed_tasks
    FROM moderation_actions a
    LEFT JOIN listings l ON l.id = a.listing_id
    LEFT JOIN moderation_refund_tasks t ON t.moderation_action_id = a.id
    WHERE a.state <> 'finalized'
    GROUP BY a.id, l.title
    ORDER BY a.created_at ASC
  `);
  return rows;
}

// Lets a moderator retry after fixing whatever blocked it (expired Stripe
// key, disputed charge resolved). Resetting attempts is what makes a
// permanently-failed task recoverable at all.
async function retryFailedTasks(actionId) {
  await query(
    "UPDATE moderation_refund_tasks SET state = 'pending', attempts = 0 WHERE moderation_action_id = $1 AND state = 'failed'",
    [actionId]
  );
  await query(
    "UPDATE moderation_actions SET state = 'settling' WHERE id = $1 AND state = 'needs_attention'",
    [actionId]
  );
  return drainTasks({ actionId });
}

module.exports = {
  ModerationSagaError,
  requestTakedown,
  drainTasks,
  reconcileActionStates,
  listUnsettled,
  retryFailedTasks,
  MAX_ATTEMPTS,
};
