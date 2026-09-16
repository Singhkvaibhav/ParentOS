const { query } = require("../db");
const { summarize } = require("./trustService");

class UserError extends Error {
  constructor(status, message, code = null, meta = null) {
    super(message);
    this.status = status;
    this.code = code;
    if (meta) this.meta = meta;
  }
}

// Minimal public profile. Deliberately excludes email (and obviously
// password_hash / verification_code) - reachable by anyone with a user id.
//
// Review aggregates now come from the cached columns via trustService
// rather than an AVG() over the reviews table on every read.
async function getPublicProfile(id) {
  const { rows } = await query(
    `SELECT id, name, verified, created_at, rating_sum, rating_count,
            completed_sales_count, completed_purchases_count
     FROM users WHERE id = $1`,
    [id]
  );
  const user = rows[0];
  if (!user) throw new UserError(404, "User not found.", "userNotFound");

  const { rows: listingRows } = await query(
    "SELECT COUNT(*) AS n FROM listings WHERE seller_id = $1 AND moderated_at IS NULL",
    [id]
  );

  const trust = summarize(user);
  return {
    id: user.id,
    name: user.name,
    created_at: user.created_at,
    listingCount: Number(listingRows[0].n),
    // Kept for backwards compatibility with existing callers/tests.
    verified: trust.verified,
    reviewCount: trust.ratingCount,
    averageRating: trust.averageRating,
    trust,
  };
}

module.exports = { UserError, getPublicProfile };
