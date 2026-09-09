const { query } = require("../db");
const { parseId } = require("../utils/validation");

class FavoriteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function list(userId) {
  const { rows } = await query(
    `SELECT listings.* FROM favorites
     JOIN listings ON listings.id = favorites.listing_id
     WHERE favorites.user_id = $1
     ORDER BY favorites.created_at DESC`,
    [userId]
  );
  return rows;
}

async function add(userId, listingIdInput) {
  const listingId = parseId(listingIdInput, "listingId", FavoriteError);
  const { rows } = await query("SELECT id FROM listings WHERE id = $1", [listingId]);
  if (!rows[0]) throw new FavoriteError(404, "Listing not found.");
  await query("INSERT INTO favorites (user_id, listing_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [userId, listingId]);
}

async function remove(userId, listingId) {
  await query("DELETE FROM favorites WHERE user_id = $1 AND listing_id = $2", [userId, listingId]);
}

module.exports = { FavoriteError, list, add, remove };
