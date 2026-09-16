const { query } = require("../db");
const { parseId } = require("../utils/validation");
const { sendNotificationEmail } = require("../email");
const { sendPush } = require("./pushService");
const logger = require("../logger");
const { BRAND } = require("../config");

class NotificationError extends Error {
  constructor(status, message, code = null, meta = null) {
    super(message);
    this.status = status;
    this.code = code;
    if (meta) this.meta = meta;
  }
}

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

// Creates a notification and delivers it over whichever of the two
// out-of-app channels apply - push if the user has a registered device
// (see pushService.js), email if they haven't opted out. Deliberately
// fire-and-forget from the caller's perspective (see notify() below): a
// marketplace action must never fail because a notification couldn't be
// delivered.
async function create({ userId, type, title, body, listingId = null, conversationId = null }) {
  const { rows } = await query(
    `INSERT INTO notifications (user_id, type, title, body, listing_id, conversation_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [userId, type, title, body || null, listingId, conversationId]
  );
  const notification = rows[0];

  // Independent of the email path below - a user might have push enabled
  // and email off, or the reverse, so neither gates the other. sendPush
  // already swallows its own delivery failures; this catch is only for
  // something failing before that point (e.g. the token lookup itself).
  sendPush(userId, { title, body, data: { type, listingId, conversationId, notificationId: notification.id } }).catch((e) =>
    logger.warn("push_notify_failed", { userId, type, err: e })
  );

  const { rows: userRows } = await query(
    "SELECT email, name, email_notifications FROM users WHERE id = $1",
    [userId]
  );
  const user = userRows[0];
  if (!user || !user.email_notifications) return notification;

  const emailBody = `Hi ${user.name},\n\n${title}${body ? `\n\n${body}` : ""}\n\nOpen ${BRAND}: ${FRONTEND_URL}\n\n- ${BRAND}\n\nTo stop these emails, turn off notifications in your profile.`;
  const result = await sendNotificationEmail(user.email, title, emailBody);
  if (result.sent) {
    await query("UPDATE notifications SET emailed_at = now() WHERE id = $1", [notification.id]);
  }

  return notification;
}

// The entry point every caller should use. Swallows all errors on purpose:
// a failed notification must never roll back or fail the thing that
// triggered it - nobody's sale should break because SMTP was down. Errors
// are logged instead so the failure is still visible.
function notify(payload) {
  create(payload).catch((e) => {
    logger.error("notification_failed", { userId: payload.userId, type: payload.type, err: e });
  });
}

// --- Reading -------------------------------------------------------------

async function list(userId, { unreadOnly = false, limit = 50 } = {}) {
  const cappedLimit = Math.min(Number(limit) || 50, 100);
  const { rows } = await query(
    `SELECT * FROM notifications
     WHERE user_id = $1 ${unreadOnly ? "AND read_at IS NULL" : ""}
     ORDER BY created_at DESC LIMIT $2`,
    [userId, cappedLimit]
  );

  const { rows: countRows } = await query(
    "SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL",
    [userId]
  );

  return { notifications: rows, unreadCount: Number(countRows[0].n) };
}

async function markRead(userId, notificationIdInput) {
  const notificationId = parseId(notificationIdInput, "notificationId", NotificationError);
  // Scoped to the owner in the WHERE clause, so one user can't mark
  // another's notifications read by guessing ids.
  const { rowCount } = await query(
    "UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL",
    [notificationId, userId]
  );
  if (rowCount === 0) {
    const { rows } = await query("SELECT 1 FROM notifications WHERE id = $1 AND user_id = $2", [notificationId, userId]);
    if (!rows[0]) throw new NotificationError(404, "Notification not found.", "notificationNotFound");
  }
}

async function markAllRead(userId) {
  await query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL", [userId]);
}

async function setEmailPreference(userId, enabled) {
  await query("UPDATE users SET email_notifications = $1 WHERE id = $2", [!!enabled, userId]);
}

module.exports = { NotificationError, notify, create, list, markRead, markAllRead, setEmailPreference };
