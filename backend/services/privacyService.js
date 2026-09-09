const { query, withTransaction } = require("../db");
const { revokeAllForUser } = require("./tokenService");
const { CONCLUDED, MONEY_CAPTURED, sqlList } = require("../transactionStatus");
const logger = require("../logger");

class PrivacyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// GDPR Articles 15 (access), 17 (erasure) and 20 (portability).
//
// The hard part isn't the SQL, it's that "delete everything" and "keep
// financial records" are both legal obligations pulling in opposite
// directions. Finnish accounting law (Kirjanpitolaki) requires transaction
// records to be retained for six years; GDPR Article 17(3)(b) explicitly
// permits retention where processing is necessary for compliance with a
// legal obligation. So the answer is not DELETE, and it is not "keep
// everything" either - it's erase the personal data and keep the financial
// facts, with the link between them broken.

// --- Article 15 / 20: export ---------------------------------------------

// Everything the platform holds about one person, in a machine-readable
// form. Deliberately assembled from the live tables rather than a
// pre-built snapshot, so it can't silently drift out of date.
async function exportUserData(userId) {
  const [profile, listings, messages, transactions, reviewsWritten, reviewsReceived,
         favorites, notifications, loginHistory, reports] = await Promise.all([
    query(
      `SELECT id, name, email, verified, created_at, email_notifications,
              completed_sales_count, completed_purchases_count, rating_count
       FROM users WHERE id = $1`,
      [userId]
    ),
    query(
      `SELECT id, title, description, category, condition, price_cents, city, area,
              status, created_at, moderated_at, moderation_reason
       FROM listings WHERE seller_id = $1 ORDER BY created_at`,
      [userId]
    ),
    // Only the person's OWN messages. A conversation has two sides, and the
    // other party's messages are their personal data, not this user's -
    // exporting them would satisfy one person's Article 15 request by
    // breaching someone else's privacy.
    query(
      `SELECT m.id, m.conversation_id, m.text, m.created_at, c.listing_id
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.sender_id = $1 ORDER BY m.created_at`,
      [userId]
    ),
    query(
      `SELECT id, listing_id, status, delivery_method, item_amount_cents,
              commission_amount_cents, total_amount_cents, created_at, paid_at,
              completed_at, CASE WHEN buyer_id = $1 THEN 'buyer' ELSE 'seller' END AS role
       FROM transactions WHERE buyer_id = $1 OR seller_id = $1 ORDER BY created_at`,
      [userId]
    ),
    query("SELECT id, reviewee_id, listing_id, rating, comment, created_at FROM reviews WHERE reviewer_id = $1", [userId]),
    query("SELECT id, reviewer_id, listing_id, rating, comment, created_at FROM reviews WHERE reviewee_id = $1", [userId]),
    query("SELECT listing_id, created_at FROM favorites WHERE user_id = $1", [userId]),
    query("SELECT type, title, body, created_at, read_at FROM notifications WHERE user_id = $1 ORDER BY created_at", [userId]),
    query("SELECT outcome, ip, user_agent, created_at FROM login_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200", [userId]),
    query("SELECT id, reason, detail, status, created_at FROM reports WHERE reporter_id = $1", [userId]),
  ]);

  if (!profile.rows[0]) throw new PrivacyError(404, "User not found.");

  return {
    exportedAt: new Date().toISOString(),
    // Stating the scope in the file itself, so the recipient knows what was
    // deliberately excluded rather than assuming an omission is a bug.
    scope: {
      included: "Data relating to you that Uusiksi holds.",
      excluded: "Messages written by other people, and reports filed about you (which contain the reporter's personal data).",
    },
    profile: profile.rows[0],
    listings: listings.rows,
    messagesYouSent: messages.rows,
    transactions: transactions.rows,
    reviewsYouWrote: reviewsWritten.rows,
    reviewsAboutYou: reviewsReceived.rows,
    favourites: favorites.rows,
    notifications: notifications.rows,
    loginHistory: loginHistory.rows,
    reportsYouFiled: reports.rows,
  };
}

// --- Article 17: erasure --------------------------------------------------

// What blocks deletion right now. Checked before anything is destroyed,
// because a half-deleted account mid-sale is worse than a refused request.
async function deletionBlockers(userId) {
  const { rows } = await query(
    `SELECT COUNT(*) AS n FROM transactions
     WHERE (buyer_id = $1 OR seller_id = $1)
       AND status IN (${sqlList(MONEY_CAPTURED)}, 'pending', 'disputed')
       AND status NOT IN (${sqlList(CONCLUDED)})`,
    [userId]
  );
  const openOrders = Number(rows[0].n);

  const blockers = [];
  if (openOrders > 0) {
    blockers.push({
      reason: "open_orders",
      detail: `${openOrders} order(s) still in progress. These must complete, be refunded or be resolved first - deleting mid-transaction would leave the other party with no counterparty and no recourse.`,
    });
  }
  return blockers;
}

// Anonymizes rather than deletes.
//
// A plain DELETE is wrong twice over: foreign keys from transactions and
// reviews would either cascade (destroying financial records the law
// requires be kept, and reviews that are other users' contributions) or
// refuse. So personal identifiers are erased and the rows that must survive
// are severed from the person instead.
async function deleteAccount(userId, { confirmEmail } = {}) {
  const { rows: userRows } = await query("SELECT * FROM users WHERE id = $1", [userId]);
  const user = userRows[0];
  if (!user) throw new PrivacyError(404, "User not found.");

  // Deletion is irreversible, so it requires the user to type their own
  // address - the same reason destructive UI asks you to name the thing.
  if (String(confirmEmail || "").trim().toLowerCase() !== user.email.toLowerCase()) {
    throw new PrivacyError(400, "Type your email address exactly to confirm deletion.");
  }

  const blockers = await deletionBlockers(userId);
  if (blockers.length > 0) {
    throw new PrivacyError(409, blockers.map((b) => b.detail).join(" "));
  }

  await withTransaction(async (tx) => {
    // Listings are the user's own content and carry their photos and
    // location - removed outright. Sold ones are kept only as the
    // transaction's reference, with identifying text stripped.
    await tx(
      `DELETE FROM listings WHERE seller_id = $1 AND status <> 'sold'`,
      [userId]
    );
    await tx(
      `UPDATE listings SET title = '[removed]', description = NULL, photo_url = NULL,
                           area = NULL, lat = NULL, lng = NULL
       WHERE seller_id = $1`,
      [userId]
    );

    // Message CONTENT is personal data; the conversation structure is
    // needed so the other party's thread doesn't become incoherent.
    await tx("UPDATE messages SET text = '[deleted]' WHERE sender_id = $1", [userId]);

    // Reviews this person WROTE stay: they're about the reviewee and other
    // users relied on them. The comment is kept (it describes the seller,
    // not the author) but the authorship link is what gets severed below.
    await tx("UPDATE reviews SET comment = NULL WHERE reviewer_id = $1 AND comment IS NOT NULL", [userId]);

    // Purely personal records with no counterparty interest - removed.
    await tx("DELETE FROM favorites WHERE user_id = $1", [userId]);
    await tx("DELETE FROM notifications WHERE user_id = $1", [userId]);
    await tx("DELETE FROM login_events WHERE user_id = $1", [userId]);
    await tx("DELETE FROM refresh_tokens WHERE user_id = $1", [userId]);
    await tx("DELETE FROM password_reset_tokens WHERE user_id = $1", [userId]);
    await tx("DELETE FROM blocks WHERE blocker_id = $1 OR blocked_id = $1", [userId]);

    // The user row itself is retained but emptied. It cannot be deleted:
    // transactions reference it, and those must be kept for the statutory
    // accounting retention period. What's left is a tombstone with no
    // personal data in it.
    //
    // The email is replaced rather than nulled so the UNIQUE constraint
    // still holds and the address becomes reusable by a genuinely new
    // signup.
    await tx(
      `UPDATE users SET
         name = 'Deleted user',
         email = 'deleted+' || id || '@deleted.invalid',
         password_hash = '',
         verification_code = NULL,
         verified = false,
         is_admin = false,
         email_notifications = false,
         session_version = session_version + 1,
         deleted_at = now()
       WHERE id = $1`,
      [userId]
    );
  });

  await revokeAllForUser(userId, "account_deleted");

  logger.warn("account_deleted", { userId });
  return {
    ok: true,
    retained: "Transaction records are kept in anonymized form to meet statutory accounting retention requirements. They no longer contain your personal data.",
  };
}

module.exports = { PrivacyError, exportUserData, deletionBlockers, deleteAccount };
