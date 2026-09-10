const { randomUUID } = require("crypto");
const { query, withTransaction } = require("../db");
const { getStripe } = require("../stripeClient");
const { parseId } = require("../utils/validation");
const { MARKETPLACE } = require("../config");
const logger = require("../logger");
const { notify } = require("./notificationsService");
const { transitionOrder, recordOrderCreated, orderHistory } = require("./orderStateMachine");
const { refreshTransactionCounters } = require("./trustService");
const { STATUS } = require("../transactionStatus");

// Marketplace economics live in config.js - see the note there.
const { deliveryFeeCents: DELIVERY_FEE_CENTS, commissionPercent: COMMISSION_PERCENT, reservationTtlMinutes: RESERVATION_TTL_MINUTES } = MARKETPLACE;

class TransactionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Starts a purchase: atomically claims the listing (active -> reserved) so
// two concurrent buyers can't both pass the availability check and both get
// a valid PaymentIntent for the same item - `rowCount` is Postgres's
// equivalent of SQLite's `.changes`, and the UPDATE ... WHERE status =
// 'active' is what's actually race-safe here, not any prior SELECT.
// `reserved_at` is stamped here too, so a periodic sweep (see
// releaseExpiredReservations below) can free listings whose buyer never
// completes payment instead of leaving them stuck forever.
async function checkout(buyerId, { listingId: listingIdInput, deliveryMethod }) {
  if (listingIdInput === undefined) throw new TransactionError(400, "listingId is required.");
  const listingId = parseId(listingIdInput, "listingId", TransactionError);
  const method = deliveryMethod === "delivery" ? "delivery" : "pickup";

  const { rows: listingRows } = await query("SELECT * FROM listings WHERE id = $1", [listingId]);
  const listing = listingRows[0];
  if (!listing) throw new TransactionError(404, "Listing not found.");
  if (listing.seller_id === buyerId) throw new TransactionError(400, "You can't buy your own listing.");
  // A listing a moderator removed must not be purchasable, even by
  // someone holding a direct link to it from before the takedown.
  if (listing.moderated_at) throw new TransactionError(409, "This listing is no longer available.");

  // (P1 #10) The seller must be able to actually receive the money before
  // a buyer is allowed to part with it. Previously checkout silently fell
  // back to collecting the full amount into the platform's own Stripe
  // account when the seller had no working Connect account - which means
  // taking a buyer's money for an item whose seller there's no automated
  // way to pay, leaving a manual reconciliation problem behind every such
  // sale. Refusing up front is the honest behaviour: the buyer isn't
  // charged, and the seller gets a clear reason to finish onboarding.
  const { rows: sellerRows } = await query(
    "SELECT stripe_connect_account_id, connect_charges_enabled FROM users WHERE id = $1",
    [listing.seller_id]
  );
  const seller = sellerRows[0];
  if (!seller?.stripe_connect_account_id || !seller.connect_charges_enabled) {
    throw new TransactionError(409, "This seller hasn't finished setting up payouts yet, so this item can't be bought right now.");
  }

  const claim = await query(
    "UPDATE listings SET status = 'reserved', reserved_at = now() WHERE id = $1 AND status = 'active'",
    [listingId]
  );
  if (claim.rowCount === 0) {
    throw new TransactionError(409, "This listing is no longer available - someone else may have just bought it.");
  }

  // Checkout spans two systems: reserve here, call Stripe, then persist
  // here. Between the reservation and the final write there is a window in
  // which a crash leaves a reserved listing, and possibly a live
  // PaymentIntent, with no completed order. The expiry sweep and
  // reconciliation both clean up after that, but neither measures how
  // often or how long it is open.
  //
  // Timing it turns "probably fine at MVP scale" into something with
  // evidence behind it - and gives a concrete trigger for replacing this
  // with an explicit checkout-attempt record (see README) rather than
  // guessing when scale demands it.
  const windowStartedAt = process.hrtime.bigint();
  const windowMs = () => Number(process.hrtime.bigint() - windowStartedAt) / 1e6;

  // Integer cents throughout - no floats, no round2(), nothing to drift.
  // The only place a fractional cent could arise is the percentage-of-cents
  // commission calculation, so that's the one spot with a single, isolated
  // Math.round() at cent granularity - not repeated float arithmetic
  // accumulating error across additions like the old euros version did.
  const itemAmountCents = listing.price_cents;
  const deliveryFeeCents = method === "delivery" ? DELIVERY_FEE_CENTS : 0;
  const totalAmountCents = itemAmountCents + deliveryFeeCents;
  const commissionAmountCents = Math.round((itemAmountCents * COMMISSION_PERCENT) / 100);

  let stripe;
  try {
    stripe = getStripe();
  } catch (e) {
    await releaseReservation(listingId);
    throw new TransactionError(503, e.message);
  }

  let paymentIntent;
  // One idempotency key per checkout attempt: if Stripe's own SDK retries
  // this call internally (its documented behavior on transient network
  // errors), the retry reuses this key and Stripe returns the original
  // PaymentIntent instead of creating a second one - without this, a
  // network blip during this exact call could silently double-charge.
  const idempotencyKey = randomUUID();
  try {
    paymentIntent = await stripe.paymentIntents.create(
      {
        amount: totalAmountCents, // Stripe's `amount` is already integer cents - no conversion needed at all now
        currency: "eur",
        metadata: { listingId: String(listing.id), buyerId: String(buyerId), sellerId: String(listing.seller_id) },
        // Destination charge: Stripe sends (total - commission) straight to
        // the seller's connected account and keeps the commission for the
        // platform. Unconditional now - checkout above refuses outright if
        // the seller can't receive charges, so there's no longer a
        // fallback path that quietly collects money the platform can't
        // forward.
        application_fee_amount: commissionAmountCents,
        transfer_data: { destination: seller.stripe_connect_account_id },
      },
      { idempotencyKey }
    );
  } catch (e) {
    logger.error("stripe_payment_intent_failed", { listingId, buyerId, err: e });
    await releaseReservation(listingId);
    throw new TransactionError(502, "Stripe couldn't create the payment - check your Stripe test keys.");
  }

  // The PaymentIntent now genuinely exists at Stripe. If persisting our own
  // record of it fails (a DB error, not a Stripe error), we'd otherwise be
  // left with a live PaymentIntent and a reserved listing that no
  // transaction row remembers - an orphaned payment. Cancel it and release
  // the reservation rather than leaving that dangling.
  let rows;
  try {
    // The row and its first audit event are written in ONE transaction.
    // Previously they were two independent statements, which left two bad
    // outcomes possible: an order whose history starts mid-lifecycle
    // (because the event insert failed), or - worse - an orphaned 'pending'
    // row left behind after the catch below cancelled its PaymentIntent.
    // Rolling back removes both.
    rows = await withTransaction(async (tx) => {
      const { rows: inserted } = await tx(
        `INSERT INTO transactions (listing_id, buyer_id, seller_id, item_amount_cents, delivery_method, delivery_fee_cents, commission_amount_cents, total_amount_cents, status, stripe_payment_intent_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)
         RETURNING *`,
        [listing.id, buyerId, listing.seller_id, itemAmountCents, method, deliveryFeeCents, commissionAmountCents, totalAmountCents, paymentIntent.id]
      );

      // Start the order's history at its beginning, so a support view never
      // shows an order that appears to materialise mid-lifecycle.
      await recordOrderCreated(inserted[0].id, buyerId, {
        paymentIntentId: paymentIntent.id,
        listingId: listing.id,
        totalAmountCents,
        deliveryMethod: method,
      }, tx);

      return inserted;
    });
  } catch (e) {
    // Logged at error with the window duration: this is the failure mode
    // the distributed checkout can produce, so its frequency should be
    // visible rather than inferred.
    logger.error("checkout_window_failed", {
      paymentIntentId: paymentIntent.id, listingId,
      windowMs: Math.round(windowMs()), err: e,
    });
    try {
      await stripe.paymentIntents.cancel(paymentIntent.id);
    } catch (cancelError) {
      logger.error("orphaned_payment_intent_needs_manual_review", { paymentIntentId: paymentIntent.id, err: cancelError });
    }
    await releaseReservation(listingId);
    throw new TransactionError(500, "Couldn't complete checkout - please try again.");
  }

  // Baseline for the window above. Without a success measurement the
  // failure logs have nothing to be compared against, and "how exposed are
  // we?" stays a matter of opinion.
  logger.info("checkout_window_closed", {
    listingId, transactionId: rows[0].id, windowMs: Math.round(windowMs()),
  });

  return {
    transaction: rows[0],
    clientSecret: paymentIntent.client_secret,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
  };
}

// Only releases a listing that's still sitting in 'reserved' - guards
// against un-reserving something that already sold through some other path.
async function releaseReservation(listingId) {
  await query("UPDATE listings SET status = 'active', reserved_at = NULL WHERE id = $1 AND status = 'reserved'", [listingId]);
}

// Stripe calls this when a payment finishes, fails, or a Connect account's
// status changes. Needs the raw request body for signature verification -
// handled in server.js before the JSON body parser runs.
//
// Every branch that mutates state does so inside a single database
// transaction, and locks the transaction row with SELECT ... FOR UPDATE
// before reading its status. That lock is the actual fix: without it, this
// handler and the reservation-expiry sweep could both read status =
// 'pending' at the same instant and then both act on it - one marking the
// sale paid while the other expires it, leaving the listing and the
// payment permanently disagreeing. With it, whichever gets there first
// wins cleanly and the other sees the already-updated status and no-ops.
//
// This also gives idempotency for free (Stripe redelivers events): a
// second delivery finds the row no longer 'pending' and does nothing.
async function handleWebhook(rawBody, signature) {
  const stripe = getStripe(); // throws if unconfigured - caller (route) turns this into a 503

  const event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);

  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object;

    const outcome = await withTransaction(async (tx) => {
      const { rows } = await tx(
        "SELECT * FROM transactions WHERE stripe_payment_intent_id = $1 FOR UPDATE",
        [paymentIntent.id]
      );
      const transaction = rows[0];
      if (!transaction) return { action: "unknown-payment" };

      if (transaction.status === "pending") {
        await transitionOrder({
          transactionId: transaction.id,
          to: STATUS.PAID,
          actorType: "system",
          reason: "Stripe confirmed payment",
          metadata: { paymentIntentId: paymentIntent.id },
          expectedFrom: STATUS.PENDING,
          tx,
        });
        await tx(
          "UPDATE listings SET status = 'sold', reserved_at = NULL WHERE id = $1 AND status = 'reserved'",
          [transaction.listing_id]
        );
        // NOTE: the trust counters are deliberately NOT touched here.
        // Payment succeeding means money changed hands, not that the deal
        // concluded - the seller still has to hand the item over and the
        // buyer still has to confirm it. Counting a sale at this point
        // would let a seller who takes payment and ships nothing accrue
        // "completed sales" on their public badge. The counters are
        // updated in confirmReceipt, where 'completed' is actually set.
        return { action: "settled", transaction };
      }

      if (["expired", "cancelled"].includes(transaction.status)) {
        // The expiry sweep (or a failure webhook) already released this
        // listing - possibly to another buyer - and *then* the original
        // payment went through on Stripe's side. We can't safely mark it
        // sold (the item may be gone), so this needs refunding. The
        // refund call itself is deliberately NOT done inside this
        // transaction: it's an external network call, and holding a
        // database transaction open across it would block the row for as
        // long as Stripe takes to respond.
        return { action: "needs-refund", transactionId: transaction.id };
      }

      return { action: "already-handled", status: transaction.status };
    });

    if (outcome.action === "settled") {
      // Both sides need to know: the seller has something to hand over,
      // the buyer wants confirmation their money actually went through.
      const t = outcome.transaction;
      const { rows: listingRows } = await query("SELECT title FROM listings WHERE id = $1", [t.listing_id]);
      const title = listingRows[0]?.title ?? "your item";

      notify({
        userId: t.seller_id,
        type: "item_sold",
        title: `"${title}" sold`,
        body: `Arrange ${t.delivery_method === "delivery" ? "delivery" : "pickup"} with the buyer in your messages.`,
        listingId: t.listing_id,
      });
      notify({
        userId: t.buyer_id,
        type: "purchase_confirmed",
        title: `Your purchase of "${title}" is confirmed`,
        body: `Message the seller to arrange ${t.delivery_method === "delivery" ? "delivery" : "pickup"}.`,
        listingId: t.listing_id,
      });
    }

    if (outcome.action === "needs-refund") {
      logger.warn("late_payment_refunding", { paymentIntentId: paymentIntent.id, transactionId: outcome.transactionId });
      try {
        // Stable idempotency key, derived from the transaction rather than
        // generated per attempt.
        //
        // Without one this was a genuine double-refund path: if
        // transitionOrder below fails, the catch swallows the error and the
        // order keeps its old status - so when Stripe retries the same
        // event (delivery is at-least-once, so retries are expected rather
        // than exceptional) this branch runs again and refunds the buyer a
        // second time. Stripe deduplicates on the key, returning the
        // original refund instead of creating another.
        await stripe.refunds.create(
          { payment_intent: paymentIntent.id },
          { idempotencyKey: `late-payment-refund-${outcome.transactionId}` }
        );
        await transitionOrder({
          transactionId: outcome.transactionId,
          to: STATUS.REFUNDED,
          actorType: "system",
          reason: "Payment arrived after the order was already resolved",
          metadata: { paymentIntentId: paymentIntent.id },
        });
      } catch (e) {
        logger.error("automatic_refund_failed", { paymentIntentId: paymentIntent.id, transactionId: outcome.transactionId, err: e });
      }
    }
  }

  if (event.type === "payment_intent.payment_failed" || event.type === "payment_intent.canceled") {
    const paymentIntent = event.data.object;

    await withTransaction(async (tx) => {
      const { rows } = await tx(
        "SELECT * FROM transactions WHERE stripe_payment_intent_id = $1 FOR UPDATE",
        [paymentIntent.id]
      );
      const transaction = rows[0];
      if (!transaction || transaction.status !== "pending") return;

      await transitionOrder({
        transactionId: transaction.id,
        to: STATUS.CANCELLED,
        actorType: "system",
        reason: "Stripe reported the payment failed",
        metadata: { paymentIntentId: paymentIntent.id },
        expectedFrom: STATUS.PENDING,
        tx,
      });
      await tx(
        "UPDATE listings SET status = 'active', reserved_at = NULL WHERE id = $1 AND status = 'reserved'",
        [transaction.listing_id]
      );
    });
  }

  if (event.type === "account.updated") {
    const account = event.data.object;
    await query(
      "UPDATE users SET connect_charges_enabled = $1, connect_payouts_enabled = $2 WHERE stripe_connect_account_id = $3",
      [!!account.charges_enabled, !!account.payouts_enabled, account.id]
    );
  }
}

// Releases listings that have sat 'reserved' longer than the TTL with no
// resolved payment - e.g. a buyer who started checkout and abandoned the
// tab, so Stripe never fires a failed/canceled event for us to react to.
// Called on an interval from server.js; also directly callable from tests.
//
// Each listing is handled in its own transaction with the same
// SELECT ... FOR UPDATE lock the webhook uses, so a payment arriving at
// the exact moment the sweep runs resolves one way or the other rather
// than both handlers acting on the same 'pending' row. SKIP LOCKED means a
// row already being settled by the webhook is simply left for that handler
// instead of blocking the whole sweep.
async function releaseExpiredReservations() {
  const { rows } = await query(
    `SELECT id FROM listings WHERE status = 'reserved' AND reserved_at < now() - ($1 || ' minutes')::interval`,
    [RESERVATION_TTL_MINUTES]
  );

  let released = 0;
  for (const { id: listingId } of rows) {
    const didRelease = await withTransaction(async (tx) => {
      const { rows: txRows } = await tx(
        "SELECT * FROM transactions WHERE listing_id = $1 AND status = 'pending' FOR UPDATE SKIP LOCKED",
        [listingId]
      );

      // Re-check the listing under the same transaction - it may have been
      // sold or released between the SELECT above and getting here.
      const { rowCount } = await tx(
        `UPDATE listings SET status = 'active', reserved_at = NULL
         WHERE id = $1 AND status = 'reserved'
           AND reserved_at < now() - ($2 || ' minutes')::interval`,
        [listingId, RESERVATION_TTL_MINUTES]
      );
      if (rowCount === 0) return false;

      if (txRows[0]) {
        await transitionOrder({
          transactionId: txRows[0].id,
          to: STATUS.EXPIRED,
          actorType: "system",
          reason: "Reservation expired before payment settled",
          tx,
        });
      }
      return true;
    });
    if (didRelease) released += 1;
  }

  return released;
}

// --- Transaction lifecycle -------------------------------------------
//
// pending -> paid -> fulfilled -> completed, with cancelled/expired/
// refunded/disputed as exceptional exits. Transitions are validated
// against this table rather than checked ad hoc at each call site, so an
// invalid move is impossible regardless of which code path attempts it.
async function loadOrderFor(userId, transactionIdInput, { role } = {}) {
  const transactionId = parseId(transactionIdInput, "transactionId", TransactionError);
  const { rows } = await query("SELECT * FROM transactions WHERE id = $1", [transactionId]);
  const transaction = rows[0];
  if (!transaction) throw new TransactionError(404, "Order not found.");

  const isBuyer = transaction.buyer_id === userId;
  const isSeller = transaction.seller_id === userId;
  if (!isBuyer && !isSeller) throw new TransactionError(403, "Not your order.");
  if (role === "buyer" && !isBuyer) throw new TransactionError(403, "Only the buyer can do that.");
  if (role === "seller" && !isSeller) throw new TransactionError(403, "Only the seller can do that.");

  return transaction;
}

// Seller marks the item handed over / posted. Previously there was no way
// to say this, so "buyer hasn't confirmed yet" was indistinguishable from
// "seller has done nothing" - exactly the ambiguity a dispute turns on.
async function markFulfilled(sellerId, transactionIdInput) {
  const transaction = await loadOrderFor(sellerId, transactionIdInput, { role: "seller" });
  return transitionOrder({
    transactionId: transaction.id,
    to: STATUS.FULFILLED,
    actorId: sellerId,
    actorType: "seller",
    expectedFrom: transaction.status,
  });
}

// Buyer confirms receipt. Deliberately buyer-only: the person who received
// the item is the one who can attest that they did, and letting a seller
// close their own sale would make the signal meaningless.
async function confirmReceipt(buyerId, transactionIdInput) {
  const transaction = await loadOrderFor(buyerId, transactionIdInput, { role: "buyer" });
  return transitionOrder({
    transactionId: transaction.id,
    to: STATUS.COMPLETED,
    actorId: buyerId,
    actorType: "buyer",
    expectedFrom: transaction.status,
  });
}

// Either party can raise a dispute - a seller can be wronged too (a buyer
// falsely claiming non-delivery). Resolution is a human decision; this
// only records that the deal is contested and freezes it there.
async function raiseDispute(userId, transactionIdInput, reason) {
  const transaction = await loadOrderFor(userId, transactionIdInput);
  if (!reason?.trim()) throw new TransactionError(400, "A reason is required to raise a dispute.");

  const updated = await transitionOrder({
    transactionId: transaction.id,
    to: STATUS.DISPUTED,
    actorId: userId,
    actorType: transaction.buyer_id === userId ? "buyer" : "seller",
    reason: reason.trim().slice(0, 2000),
    expectedFrom: transaction.status,
  });

  // The disputing party's counterpart needs to know; the state machine
  // has no generic "other party" concept, so this one stays here.
  const otherParty = transaction.buyer_id === userId ? transaction.seller_id : transaction.buyer_id;
  const { rows: listingRows } = await query("SELECT title FROM listings WHERE id = $1", [transaction.listing_id]);
  notify({
    userId: otherParty,
    type: "order_disputed",
    title: `A problem was raised with "${listingRows[0]?.title ?? "your item"}"`,
    body: "We'll be in touch to sort it out.",
    listingId: transaction.listing_id,
  });
  logger.warn("order_disputed", { transactionId: transaction.id, raisedBy: userId });

  return updated;
}

// (P0 #1) Called when a moderator takes a listing down. A takedown means
// the item shouldn't be sold - so any money already in flight for it has
// to be dealt with, not silently left. Previously takedown ignored
// transactions entirely: a buyer could have paid for a recalled car seat
// and the takedown would hide the listing while quietly keeping their
// money and leaving the order looking normal.
//
// Two cases, deliberately handled differently:
//   pending - payment not settled. Cancel the PaymentIntent so it can
//             never capture, and mark the order cancelled.
//   paid/fulfilled - money is captured. Refund it and mark refunded.
// Anything already 'completed' is left alone: the buyer has the item and
// confirmed it, so a moderation decision about the listing shouldn't
// unwind a finished deal - that's a dispute, not an automatic refund.
// Resolves a dispute. Admin-only: the two parties disagree by definition,
// so letting either of them close it would just hand the argument to
// whoever clicked first.
//
// Two outcomes, both already declared legal in VALID_TRANSITIONS but
// previously unimplemented - the state was reachable with no way out,
// which meant every dispute was permanent and the money was frozen with it.
//
//   'refund'  - buyer is made whole; money returns via Stripe
//   'uphold'  - the order stands as completed; the seller keeps the money
async function listingTitle(listingId) {
  const { rows } = await query("SELECT title FROM listings WHERE id = $1", [listingId]);
  return rows[0]?.title ?? "your item";
}

async function resolveDispute(adminId, transactionIdInput, { outcome, note }) {
  const { rows: adminRows } = await query("SELECT is_admin FROM users WHERE id = $1", [adminId]);
  if (!adminRows[0]?.is_admin) throw new TransactionError(403, "Moderator access required.");

  const transactionId = parseId(transactionIdInput, "transactionId", TransactionError);
  if (!["refund", "uphold"].includes(outcome)) {
    throw new TransactionError(400, "Outcome must be 'refund' or 'uphold'.");
  }
  if (!note?.trim()) {
    // A resolution with no rationale is unreviewable later, and disputes
    // are exactly the records that get re-examined.
    throw new TransactionError(400, "A resolution note is required.");
  }

  const { rows } = await query("SELECT * FROM transactions WHERE id = $1", [transactionId]);
  const transaction = rows[0];
  if (!transaction) throw new TransactionError(404, "Order not found.");
  if (transaction.status !== STATUS.DISPUTED) {
    throw new TransactionError(409, "That order isn't disputed.");
  }

  if (outcome === "refund") {
    // Money first, then state. If Stripe fails, the order stays 'disputed'
    // and the admin sees an error - which is recoverable. Marking it
    // refunded first and then failing would tell everyone the buyer had
    // been paid back when they hadn't.
    let stripe;
    try {
      stripe = getStripe();
    } catch {
      throw new TransactionError(503, "Stripe isn't configured, so a refund can't be issued.");
    }

    if (transaction.stripe_payment_intent_id) {
      await stripe.refunds.create(
        { payment_intent: transaction.stripe_payment_intent_id },
        // Keyed on the transaction so a retried resolution can't refund twice.
        { idempotencyKey: `dispute-resolve-${transactionId}` }
      );
    }
  }

  await transitionOrder({
    transactionId,
    to: outcome === "refund" ? STATUS.REFUNDED : STATUS.COMPLETED,
    actorId: adminId,
    actorType: "admin",
    reason: note.trim().slice(0, 2000),
    metadata: { disputeOutcome: outcome },
  });

  // Trust counters are derived from 'completed', so upholding restores the
  // seller's credit for the sale and refunding leaves it removed. Both
  // happen automatically because the counters recompute from source.
  await refreshTransactionCounters(transaction.seller_id);
  await refreshTransactionCounters(transaction.buyer_id);

  const title = await listingTitle(transaction.listing_id);
  for (const userId of [transaction.buyer_id, transaction.seller_id]) {
    notify({
      userId,
      type: outcome === "refund" ? "order_cancelled" : "order_completed",
      title: `The problem with "${title}" has been resolved`,
      body: outcome === "refund" ? "The buyer has been refunded." : "The order stands as completed.",
      listingId: transaction.listing_id,
    });
  }

  logger.warn("dispute_resolved", { transactionId, adminId, outcome });

  const { rows: updated } = await query("SELECT * FROM transactions WHERE id = $1", [transactionId]);
  return updated[0];
}

// The order's audit trail. Visible to the two parties and to admins -
// it's their transaction, and in a dispute the timeline is the evidence.
async function history(userId, transactionIdInput) {
  const transaction = await loadOrderFor(userId, transactionIdInput);
  return orderHistory(transaction.id);
}

async function mine(userId) {
  const { rows } = await query(
    `SELECT transactions.*, listings.title AS listing_title
     FROM transactions
     JOIN listings ON listings.id = transactions.listing_id
     WHERE transactions.buyer_id = $1 OR transactions.seller_id = $1
     ORDER BY transactions.created_at DESC`,
    [userId]
  );
  return rows.map((t) => ({
    ...t,
    listingTitle: t.listing_title,
    role: t.buyer_id === userId ? "buyer" : "seller",
  }));
}

module.exports = { TransactionError, checkout, handleWebhook, releaseExpiredReservations, confirmReceipt, markFulfilled, raiseDispute, resolveDispute, history, mine, DELIVERY_FEE_CENTS, COMMISSION_PERCENT, RESERVATION_TTL_MINUTES };
