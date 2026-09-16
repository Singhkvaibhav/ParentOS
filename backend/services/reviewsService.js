const { query } = require("../db");
const { parseId } = require("../utils/validation");
const { notify } = require("./notificationsService");
const { CONCLUDED, sqlList } = require("../transactionStatus");
const { refreshRatingAggregates } = require("./trustService");

class ReviewError extends Error {
  constructor(status, message, code = null, meta = null) {
    super(message);
    this.status = status;
    this.code = code;
    if (meta) this.meta = meta;
  }
}

async function listForUser(userId) {
  const { rows } = await query(
    `SELECT reviews.*, users.name AS reviewer_name FROM reviews
     JOIN users ON users.id = reviews.reviewer_id
     WHERE reviews.reviewee_id = $1
     ORDER BY reviews.created_at DESC`,
    [userId]
  );
  return rows;
}

// A review can only be left by someone who actually completed a paid
// transaction with the person they're reviewing, for the specific listing
// named - otherwise this is just an open "leave a rating for anyone"
// endpoint, which is exactly the kind of thing that makes reviews useless
// (or actively abusable) as a trust signal.
async function create(reviewerId, { revieweeId: revieweeIdInput, listingId: listingIdInput, rating, comment }) {
  if (revieweeIdInput === undefined || listingIdInput === undefined || !(Number(rating) >= 1 && Number(rating) <= 5)) {
    throw new ReviewError(400, "revieweeId, listingId, and a rating from 1-5 are required.");
  }
  const revieweeId = parseId(revieweeIdInput, "revieweeId", ReviewError);
  const listingId = parseId(listingIdInput, "listingId", ReviewError);
  if (revieweeId === reviewerId) throw new ReviewError(400, "You can't review yourself.", "cantReviewYourself");

  // Requires status = 'completed', not merely 'paid'. The same distinction
  // the trust counters now make: payment succeeding doesn't mean the deal
  // concluded. Allowing a review at 'paid' would let ratings - which feed
  // the public trust badge - be written before anyone received anything,
  // so a seller could accumulate stars without ever handing an item over.
  //
  // Known trade-off: a seller who takes payment and then goes silent can't
  // be reviewed, because the order never reaches 'completed'. The recourse
  // is the dispute flow rather than a review, which is the right shape (a
  // ghosted buyer wants their money back, not a star rating) - but it does
  // mean review counts under-represent bad sellers. Worth revisiting once
  // there's a dispute-resolution path that can settle an order.
  const { rows } = await query(
    `SELECT * FROM transactions
     WHERE listing_id = $1
       AND status IN (${sqlList(CONCLUDED)})
       AND (
         (buyer_id = $2 AND seller_id = $3) OR
         (seller_id = $2 AND buyer_id = $3)
       )`,
    [listingId, reviewerId, revieweeId]
  );
  if (!rows[0]) {
    throw new ReviewError(403, "You can only review someone once the order is complete - the buyer needs to confirm they received the item first.", "reviewNeedsCompletion");
  }

  try {
    await query(
      "INSERT INTO reviews (reviewer_id, reviewee_id, listing_id, rating, comment) VALUES ($1, $2, $3, $4, $5)",
      [reviewerId, revieweeId, listingId, Number(rating), comment || null]
    );
  } catch (e) {
    if (e.code === "23505") throw new ReviewError(409, "You've already reviewed this person for this listing.", "alreadyReviewed"); // unique_violation
    throw e;
  }

  // Recompute the reviewee's cached aggregates so profile reads never
  // have to AVG() over the reviews table.
  await refreshRatingAggregates(revieweeId);

  notify({
    userId: revieweeId,
    type: "review_received",
    title: `You received a ${rating}-star review`,
    body: comment ? String(comment).slice(0, 200) : null,
    listingId,
  });
}

module.exports = { ReviewError, listForUser, create };
