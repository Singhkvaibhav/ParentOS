const { query, withTransaction } = require("../db");
const { STATUS, CONCLUDED, VALID_TRANSITIONS } = require("../transactionStatus");
const { refreshTransactionCounters } = require("./trustService");
const { notify } = require("./notificationsService");
const logger = require("../logger");

// The order lifecycle as a first-class concept.
//
// Every status change goes through transitionOrder(). Before this, nine
// call sites each did their own UPDATE, and each was individually
// responsible for remembering to set the right timestamp, refresh the
// trust counters, and notify the other party. That's how the trust
// counters ended up counting payments instead of completions: the
// lifecycle changed but one of the nine sites kept its old assumption.
//
// Concentrating it here means a new status or a new side effect is one
// edit, and - more importantly - it is impossible to change an order's
// status *without* the audit event, because the write and the event are
// the same database transaction.

class OrderTransitionError extends Error {
  constructor(status, message, code = null, meta = null) {
    super(message);
    this.status = status;
    this.code = code;
    if (meta) this.meta = meta;
  }
}

// Which timestamp column each status stamps on arrival. Statuses absent
// from this map simply don't have one.
const TIMESTAMP_COLUMN = {
  [STATUS.PAID]: "paid_at",
  [STATUS.FULFILLED]: "fulfilled_at",
  [STATUS.COMPLETED]: "completed_at",
  [STATUS.DISPUTED]: "disputed_at",
};

// A human-readable event name per destination status, so the audit trail
// reads as a sequence of things that happened rather than a list of enum
// values.
const EVENT_TYPE = {
  [STATUS.PAID]: "payment_settled",
  [STATUS.FULFILLED]: "order_fulfilled",
  [STATUS.COMPLETED]: "receipt_confirmed",
  [STATUS.DISPUTED]: "dispute_raised",
  [STATUS.REFUNDED]: "payment_refunded",
  [STATUS.CANCELLED]: "order_cancelled",
  [STATUS.EXPIRED]: "reservation_expired",
};

// Notifications are declared per destination status rather than written
// at each call site, so adding a status can't silently leave one party
// uninformed. `null` means nobody is notified for that transition.
//
// Each builder returns { userId, type, title, body } or null.
const NOTIFICATION = {
  [STATUS.FULFILLED]: (t, title) => ({
    userId: t.buyer_id,
    type: "order_fulfilled",
    title: `"${title}" is on its way`,
    body: "Confirm receipt once you have it.",
  }),
  [STATUS.COMPLETED]: (t, title) => ({
    userId: t.seller_id,
    type: "order_completed",
    title: `The buyer confirmed receipt of "${title}"`,
    body: "You can now leave them a review.",
  }),
  [STATUS.REFUNDED]: (t, title) => ({
    userId: t.buyer_id,
    type: "order_cancelled",
    title: `Your order for "${title}" was refunded`,
    body: "Any payment has been returned to you.",
  }),
  [STATUS.CANCELLED]: (t, title) => ({
    userId: t.buyer_id,
    type: "order_cancelled",
    title: `Your order for "${title}" was cancelled`,
    body: "No payment was taken.",
  }),
};

async function listingTitle(listingId, tx) {
  const { rows } = await tx("SELECT title FROM listings WHERE id = $1", [listingId]);
  return rows[0]?.title ?? "your item";
}

/**
 * Moves an order to a new status, atomically, with its audit event.
 *
 * @param {object}  opts
 * @param {number}  opts.transactionId
 * @param {string}  opts.to            destination status
 * @param {number}  [opts.actorId]     null for system-initiated changes
 * @param {string}  opts.actorType     buyer | seller | admin | system
 * @param {string}  [opts.reason]
 * @param {object}  [opts.metadata]    Stripe ids, refund ids, etc.
 * @param {string}  [opts.expectedFrom] guard against a concurrent change
 * @param {Function}[opts.tx]          run inside an existing transaction
 */
// Statuses where an explanation is part of the record, not just metadata:
// a buyer looking at a refunded order should be able to see why.
const REVERSAL_STATES = new Set(["cancelled", "refunded", "expired"]);

async function transitionOrder({
  transactionId, to, actorId = null, actorType, reason = null,
  metadata = {}, expectedFrom = null, tx = null,
}) {
  const run = async (q) => {
    // SELECT ... FOR UPDATE: two concurrent transitions on the same order
    // (a buyer confirming receipt while a moderator refunds, say) must
    // serialize, or both would validate against the same stale status and
    // one would silently overwrite the other.
    const { rows } = await q("SELECT * FROM transactions WHERE id = $1 FOR UPDATE", [transactionId]);
    const order = rows[0];
    if (!order) throw new OrderTransitionError(404, "Order not found.", "orderNotFound");

    const from = order.status;

    // Idempotency: re-delivering the same webhook, or a double-clicked
    // button, should be a no-op rather than an error or a duplicate event.
    if (from === to) return { order, changed: false };

    if (expectedFrom && from !== expectedFrom) {
      throw new OrderTransitionError(409, `This order is no longer '${expectedFrom}'.`);
    }
    if (!VALID_TRANSITIONS[from]?.includes(to)) {
      throw new OrderTransitionError(409, `An order that is '${from}' can't become '${to}'.`);
    }

    const timestampColumn = TIMESTAMP_COLUMN[to];
    const { rows: updated } = await q(
      // cancellation_reason is kept in sync here rather than being patched
      // by callers afterwards. The reason also lives in the audit event,
      // but this denormalized column is what the transaction row itself
      // exposes - letting the two disagree would mean an order could show
      // as refunded with no explanation attached to it.
      `UPDATE transactions
         SET status = $1${timestampColumn ? `, ${timestampColumn} = now()` : ""}
             ${REVERSAL_STATES.has(to) ? ", cancellation_reason = COALESCE($4, cancellation_reason)" : ""}
       WHERE id = $2 AND status = $3
       RETURNING *`,
      REVERSAL_STATES.has(to) ? [to, transactionId, from, reason] : [to, transactionId, from]
    );
    if (!updated[0]) throw new OrderTransitionError(409, "The order changed while we were updating it.", "orderChanged");

    // The audit event is written in the SAME transaction as the status
    // change. That's the point: an order's status can never move without
    // leaving a record of who moved it and why.
    await q(
      `INSERT INTO transaction_events
         (transaction_id, event_type, from_status, to_status, actor_id, actor_type, reason, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        transactionId, EVENT_TYPE[to] || `status_${to}`, from, to,
        actorId, actorType, reason, JSON.stringify(metadata),
      ]
    );

    // Trust counters are derived from 'completed', so any transition into
    // or out of it changes them. Recomputed rather than incremented, so a
    // completed order that's later disputed correctly drops back out.
    const touchesConcluded = CONCLUDED.includes(from) || CONCLUDED.includes(to);
    if (touchesConcluded) {
      await refreshTransactionCounters(order.seller_id, q);
      await refreshTransactionCounters(order.buyer_id, q);
    }

    const title = await listingTitle(order.listing_id, q);
    return { order: updated[0], changed: true, notification: NOTIFICATION[to]?.(order, title) ?? null };
  };

  // Reuse the caller's transaction when given one (so a webhook's status
  // change and its listing update stay atomic together), otherwise open
  // our own.
  const result = tx ? await run(tx) : await withTransaction(run);

  if (result.changed) {
    logger.info("order_transition", {
      transactionId, from: result.order.status, to, actorType, actorId,
    });
    // Notifications fire only after the transaction has committed - a
    // notification about a change that then rolled back would be a lie,
    // and they're deliberately non-blocking anyway.
    if (result.notification) notify({ ...result.notification, listingId: result.order.listing_id });
  }

  return result.order;
}

// Full history for one order, oldest first. Used by support and by the
// order detail view.
async function orderHistory(transactionId) {
  const { rows } = await query(
    `SELECT e.*, u.name AS actor_name
     FROM transaction_events e
     LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.transaction_id = $1
     ORDER BY e.id ASC`,
    [transactionId]
  );
  return rows;
}

// Records the creation of an order, so its history starts at the
// beginning rather than at its first transition.
async function recordOrderCreated(transactionId, buyerId, metadata = {}, tx = query) {
  await tx(
    `INSERT INTO transaction_events
       (transaction_id, event_type, from_status, to_status, actor_id, actor_type, metadata)
     VALUES ($1, 'order_created', NULL, $2, $3, 'buyer', $4)`,
    [transactionId, STATUS.PENDING, buyerId, JSON.stringify(metadata)]
  );
}

module.exports = { OrderTransitionError, transitionOrder, orderHistory, recordOrderCreated, EVENT_TYPE };
