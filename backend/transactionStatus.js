// Single source of truth for transaction statuses and what they MEAN.
//
// The status values were previously correct but scattered across
// analyticsService, trustService, reviewsService and transactionsService.
// That's how the "paid counted as completed" bug happened in the first
// place: the lifecycle changed in one file and four other files kept the
// old assumption, each phrased slightly differently so no search found
// them all at once.
//
// Everything below is expressed as a named business concept rather than a
// raw list, so a future lifecycle change is one edit here instead of a
// hunt through SQL string literals.

const STATUS = Object.freeze({
  PENDING: "pending",     // checkout started, payment not settled
  PAID: "paid",           // money captured, item NOT yet handed over
  FULFILLED: "fulfilled", // seller says they handed it over
  COMPLETED: "completed", // buyer confirmed receipt - the deal is done
  CANCELLED: "cancelled", // never paid
  EXPIRED: "expired",     // reservation timed out before payment settled
  REFUNDED: "refunded",   // money returned
  DISPUTED: "disputed",   // contested; needs a human
});

const ALL_STATUSES = Object.freeze(Object.values(STATUS));

// --- Business groupings ---------------------------------------------------

// Money has actually been captured and not returned. This is the right set
// for revenue questions (GMV, commission earned) - a paid order is real
// money even though the deal hasn't concluded.
const MONEY_CAPTURED = Object.freeze([STATUS.PAID, STATUS.FULFILLED, STATUS.COMPLETED]);

// Paid for but not yet finished: someone is waiting on someone else.
// Useful as an operational backlog, and deliberately NOT counted as sales.
const AWAITING_HANDOVER = Object.freeze([STATUS.PAID, STATUS.FULFILLED]);

// The deal concluded: the buyer confirmed they received the item. This is
// the ONLY set that may drive trust signals, sale counts, or review
// eligibility. Payment succeeding is not membership in this set.
const CONCLUDED = Object.freeze([STATUS.COMPLETED]);

// Money moved and then came back, or never moved at all.
const REVERSED = Object.freeze([STATUS.CANCELLED, STATUS.REFUNDED]);

// Orders a moderator takedown has to resolve: money is either committed or
// already captured, so it can't simply be abandoned.
const IN_FLIGHT_FOR_MODERATION = Object.freeze([STATUS.PENDING, STATUS.PAID, STATUS.FULFILLED]);

// --- Lifecycle ------------------------------------------------------------

// Which transitions are legal. Kept here beside the groupings so the
// lifecycle and the things derived from it can't drift apart.
const VALID_TRANSITIONS = Object.freeze({
  [STATUS.PENDING]: [STATUS.PAID, STATUS.CANCELLED, STATUS.EXPIRED],
  [STATUS.PAID]: [STATUS.FULFILLED, STATUS.COMPLETED, STATUS.REFUNDED, STATUS.DISPUTED],
  [STATUS.FULFILLED]: [STATUS.COMPLETED, STATUS.DISPUTED, STATUS.REFUNDED],
  [STATUS.COMPLETED]: [STATUS.DISPUTED], // a problem can surface after the fact
  [STATUS.DISPUTED]: [STATUS.REFUNDED, STATUS.COMPLETED], // a human resolves it either way
  // Not terminal, despite looking it: Stripe can confirm a payment AFTER
  // we've given up on the order (the reservation expired, or the payment
  // was reported failed and then succeeded on retry). When that happens
  // real money has moved and it has to be refunded, which means moving
  // out of these states.
  //
  // This table previously declared both terminal. Nothing caught it
  // because the late-payment path did a raw UPDATE that never consulted
  // the table - routing every status change through transitionOrder is
  // what surfaced the inconsistency.
  [STATUS.CANCELLED]: [STATUS.REFUNDED],
  [STATUS.EXPIRED]: [STATUS.REFUNDED],
  // Genuinely terminal: the money is back with the buyer.
  [STATUS.REFUNDED]: [],
});

// --- SQL helper -----------------------------------------------------------

// Renders a group as a SQL literal list, e.g. "'paid', 'fulfilled'".
//
// These are our own frozen constants, never user input, so there is no
// injection path - but the membership assertion means a typo in a group
// definition fails loudly at startup rather than silently producing a
// filter that matches nothing (which would look like "no sales yet"
// instead of like a bug).
function sqlList(statuses) {
  for (const status of statuses) {
    if (!ALL_STATUSES.includes(status)) {
      throw new Error(`Unknown transaction status in group: ${status}`);
    }
  }
  return statuses.map((s) => `'${s}'`).join(", ");
}

module.exports = {
  STATUS,
  ALL_STATUSES,
  MONEY_CAPTURED,
  AWAITING_HANDOVER,
  CONCLUDED,
  REVERSED,
  IN_FLIGHT_FOR_MODERATION,
  VALID_TRANSITIONS,
  sqlList,
};
