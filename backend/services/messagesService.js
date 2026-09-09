const { query } = require("../db");
const { getAutoReply } = require("../ai/controller");
const logger = require("../logger");
const { isBlockedBetween } = require("./moderationService");
const { notify } = require("./notificationsService");
const { LIMITS } = require("../config");
const { isEnabled: queuesEnabled, enqueue, QUEUE_NAMES } = require("../queue");

// Every user can be a buyer in one thread and a seller in another - there's
// no separate "buyer inbox" vs "seller inbox", just conversations the
// current user participates in, tagged with their role in each one.
//
// Messages are their own table (see database/migrations/) - each INSERT is
// independent and row-level, so two people replying in the same
// conversation "at once" just produces two ordered rows, never a
// read-modify-write race.
//
// The AI auto-reply has its own, separate race to guard against: if a
// buyer sends two messages before the first AI reply finishes generating,
// naively checking "has the seller replied yet" before each one could
// trigger two concurrent AI calls for the same conversation. Fixed the
// same way the checkout race was fixed - an atomic claim
// (`ai_replied`) that only one concurrent request can win, and which stays
// permanently set once claimed - not just an in-flight lock.

class MessageError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function roleOf(row, userId) {
  if (row.buyer_id === userId) return "buyer";
  if (row.seller_id === userId) return "seller";
  return null;
}

// (P1 #7) Messages are paginated with a cursor rather than returned in
// full. A long-running conversation would otherwise re-send its entire
// history on every poll - growing without bound, on the app's most
// frequently hit endpoint.
//
// Cursor-based rather than offset: messages are appended constantly, so an
// offset shifts under the reader and would skip or duplicate rows.
// A message id is a stable anchor.
//
// Fetches the NEWEST page by default and returns it in chronological
// order, because a chat opens at the bottom - "the most recent 50" is what
// a client actually needs first.
const MESSAGE_PAGE_SIZE = 50;

async function getMessages(conversationId, { before = null, limit = MESSAGE_PAGE_SIZE } = {}) {
  const cappedLimit = Math.min(Math.max(Number(limit) || MESSAGE_PAGE_SIZE, 1), 100);

  const params = [conversationId];
  let cursorClause = "";
  if (before) {
    params.push(Number(before));
    cursorClause = ` AND id < $${params.length}`;
  }
  params.push(cappedLimit + 1); // one extra row tells us whether more exist

  const { rows } = await query(
    `SELECT id, sender_id AS "senderId", sender_type AS "senderType", text, created_at AS "createdAt"
     FROM messages WHERE conversation_id = $1${cursorClause}
     ORDER BY id DESC LIMIT $${params.length}`,
    params
  );

  const hasMore = rows.length > cappedLimit;
  const page = hasMore ? rows.slice(0, cappedLimit) : rows;
  page.reverse(); // back to chronological for display

  return {
    messages: page,
    hasMore,
    // The id to pass as `before` to fetch the previous page.
    nextCursor: hasMore && page.length > 0 ? page[0].id : null,
  };
}

async function unreadCountFor(conversationId, row, role) {
  const lastRead = role === "buyer" ? row.buyer_last_read_at : row.seller_last_read_at;
  const otherSenderType = role === "buyer" ? "sender_type != 'buyer'" : "sender_type = 'buyer'";
  const { rows } = await query(
    `SELECT COUNT(*) AS n FROM messages WHERE conversation_id = $1 AND ${otherSenderType} AND created_at > COALESCE($2, '-infinity'::timestamptz)`,
    [conversationId, lastRead || null]
  );
  return Number(rows[0].n);
}

async function serializeThread(row, viewerId) {
  const [{ rows: userRows }, messagePage] = await Promise.all([
    query("SELECT id, name FROM users WHERE id = ANY($1::int[])", [[row.buyer_id, row.seller_id]]),
    getMessages(row.id),
  ]);
  const messages = messagePage.messages;
  const buyer = userRows.find((u) => u.id === row.buyer_id);
  const seller = userRows.find((u) => u.id === row.seller_id);
  const role = viewerId ? roleOf(row, viewerId) : null;
  return {
    id: row.id,
    listingId: row.listing_id,
    buyerId: row.buyer_id,
    sellerId: row.seller_id,
    buyerName: buyer?.name,
    sellerName: seller?.name,
    sellerReplied: !!row.seller_replied,
    created_at: row.created_at,
    messages,
    hasMoreMessages: messagePage.hasMore,
    messagesCursor: messagePage.nextCursor,
    ...(role ? { role, unreadCount: await unreadCountFor(row.id, row, role) } : {}),
  };
}

// Two messages sent at the same instant on a listing with no existing
// conversation would both pass a check-then-act "SELECT, then INSERT if
// missing" - one would then fail on the UNIQUE(listing_id, buyer_id)
// constraint. ON CONFLICT DO NOTHING plus a re-SELECT makes the race
// harmless: whichever INSERT loses simply reads the row the winner
// created, and both requests proceed against the same conversation.
async function getOrCreateConversation(listing, buyerId) {
  const inserted = await query(
    `INSERT INTO conversations (listing_id, buyer_id, seller_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (listing_id, buyer_id) DO NOTHING
     RETURNING *`,
    [listing.id, buyerId, listing.seller_id]
  );
  if (inserted.rows[0]) return inserted.rows[0];

  const { rows } = await query(
    "SELECT * FROM conversations WHERE listing_id = $1 AND buyer_id = $2",
    [listing.id, buyerId]
  );
  return rows[0];
}

async function insertMessage(conversationId, { senderId, senderType, text }) {
  await query(
    "INSERT INTO messages (conversation_id, sender_id, sender_type, text) VALUES ($1, $2, $3, $4)",
    [conversationId, senderId, senderType, text]
  );
}

async function markRead(conversationId, role) {
  const column = role === "buyer" ? "buyer_last_read_at" : "seller_last_read_at";
  await query(`UPDATE conversations SET ${column} = now() WHERE id = $1`, [conversationId]);
}

// Atomically claims the right to generate this conversation's (single) AI
// reply - only the request that wins this UPDATE proceeds. The flag is
// permanent once set (never reset back to false), which is what actually
// fixes the race: it's not just a lock against two replies generating at
// the exact same instant, it prevents a *second*, later buyer message from
// triggering *another* AI reply once the first has already been given,
// which a transient in-flight-only lock would still allow (proven by a
// test - see messages.test.js).
async function claimAiReply(conversationId) {
  const { rowCount } = await query(
    "UPDATE conversations SET ai_replied = true WHERE id = $1 AND ai_replied = false AND seller_replied = false",
    [conversationId]
  );
  return rowCount > 0;
}

// Generates and inserts the AI auto-reply without the buyer's request
// waiting on it - the HTTP response has already gone out by the time this
// runs.
//
// Two failure modes are handled explicitly here:
//
// (#6) If generation FAILS, the claim is released (ai_replied back to
// false) rather than left set. Previously a failed call left the flag
// permanently true, which meant the conversation could never get an AI
// reply again - a transient API blip silently disabled the feature for
// that thread forever. Releasing it means the buyer's next message can
// try again.
//
// (#5) If the seller replies for real WHILE this is generating, the
// generated text is discarded instead of inserted. Otherwise the AI's
// stand-in answer lands *after* the seller's actual answer, which is
// confusing at best and contradictory at worst. The insert is conditional
// on seller_replied still being false, checked inside the same statement
// so there's no read-then-write gap for the seller's reply to slip into.
// (#8) Schedules the AI reply. Prefers the durable queue; falls back to
// running in-process when Redis isn't configured.
//
// The claim is taken HERE, before dispatching either way, so the
// duplicate-reply protection works identically on both paths - moving it
// into the worker would open a window where two enqueued jobs could both
// pass the check.
async function triggerAiReplyInBackground(conversationId, listing, buyerText, requestId) {
  const claimed = await claimAiReply(conversationId);
  if (!claimed) return; // an AI reply was already given, or the seller just replied for real

  if (queuesEnabled()) {
    const queued = await enqueue(QUEUE_NAMES.AI_REPLY, "generate", {
      conversationId,
      listingId: listing?.id,
      buyerText,
      requestId,
    });
    if (queued) return;

    // Queue accepted nothing (Redis down mid-flight). Better to run
    // inline than to leave the buyer with a claimed-but-never-answered
    // conversation.
    logger.warn("ai_reply_queue_unavailable_running_inline", { conversationId });
  }

  await runAiReply(conversationId, listing, buyerText);
}

// The actual work, shared by the queue worker and the inline fallback so
// the two paths can't drift apart.
async function runAiReply(conversationId, listing, buyerText) {
  let aiText;
  try {
    aiText = await getAutoReply(listing, buyerText);
  } catch (e) {
    logger.warn("ai_reply_failed_claim_released", { conversationId, err: e });
    await query("UPDATE conversations SET ai_replied = false WHERE id = $1", [conversationId]);
    return;
  }

  const { rowCount } = await query(
    `INSERT INTO messages (conversation_id, sender_id, sender_type, text)
     SELECT $1, NULL, 'ai', $2
     WHERE EXISTS (SELECT 1 FROM conversations WHERE id = $1 AND seller_replied = false)`,
    [conversationId, aiText]
  );
  if (rowCount === 0) {
    logger.info("ai_reply_discarded_seller_replied_first", { conversationId });
  }
}

// Used by the queue worker: it only carries ids across the process
// boundary, so the listing has to be re-read here.
async function runAiReplyForJob({ conversationId, listingId, buyerText }) {
  const { rows } = await query("SELECT * FROM listings WHERE id = $1", [listingId]);
  if (!rows[0]) {
    logger.warn("ai_reply_listing_gone", { conversationId, listingId });
    await query("UPDATE conversations SET ai_replied = false WHERE id = $1", [conversationId]);
    return;
  }
  await runAiReply(conversationId, rows[0], buyerText);
}

// --- Unified, role-agnostic ------------------------------------------------

// The unified inbox needs every conversation, its listing title, both
// participants' names, and an unread count - naively that's 3 extra
// queries PER conversation (see serializeThread, used by the
// single-conversation endpoints below where that's fine). Batched instead:
// exactly 4 queries total no matter how many conversations there are.
async function myConversations(userId) {
  const { rows } = await query(
    "SELECT * FROM conversations WHERE buyer_id = $1 OR seller_id = $1 ORDER BY created_at DESC",
    [userId]
  );
  if (rows.length === 0) return { conversations: [], totalUnread: 0 };

  const conversationIds = rows.map((r) => r.id);
  const listingIds = [...new Set(rows.map((r) => r.listing_id))];
  const userIds = [...new Set(rows.flatMap((r) => [r.buyer_id, r.seller_id]))];

  const [{ rows: listingRows }, { rows: userRows }, { rows: messageRows }] = await Promise.all([
    query("SELECT id, title FROM listings WHERE id = ANY($1::int[])", [listingIds]),
    query("SELECT id, name FROM users WHERE id = ANY($1::int[])", [userIds]),
    // (P1 #7) The inbox needs only a preview and an unread count per
    // conversation - it was previously loading EVERY message across EVERY
    // conversation to derive them, which grows without bound as threads
    // get longer. DISTINCT ON gives just the latest message per thread,
    // and the unread counts come from a single grouped COUNT below.
    query(
      `SELECT DISTINCT ON (conversation_id)
              conversation_id AS "conversationId", sender_type AS "senderType", text, created_at AS "createdAt"
       FROM messages WHERE conversation_id = ANY($1::int[])
       ORDER BY conversation_id, id DESC`,
      [conversationIds]
    ),
  ]);

  // Unread counts computed in SQL per conversation, rather than by
  // filtering full message arrays in JS.
  const { rows: unreadRows } = await query(
    `SELECT c.id AS conversation_id,
            COUNT(m.id) FILTER (
              WHERE m.created_at > COALESCE(
                      CASE WHEN c.buyer_id = $2 THEN c.buyer_last_read_at ELSE c.seller_last_read_at END,
                      '-infinity'::timestamptz)
                AND ((c.buyer_id = $2 AND m.sender_type <> 'buyer')
                  OR (c.seller_id = $2 AND m.sender_type = 'buyer'))
            ) AS unread
     FROM conversations c
     LEFT JOIN messages m ON m.conversation_id = c.id
     WHERE c.id = ANY($1::int[])
     GROUP BY c.id`,
    [conversationIds, userId]
  );
  const unreadByConversation = Object.fromEntries(unreadRows.map((r) => [r.conversation_id, Number(r.unread)]));

  const listingTitleById = Object.fromEntries(listingRows.map((l) => [l.id, l.title]));
  const userNameById = Object.fromEntries(userRows.map((u) => [u.id, u.name]));
  const latestByConversation = Object.fromEntries(messageRows.map((m) => [m.conversationId, m]));

  const conversations = rows.map((row) => {
    const role = roleOf(row, userId);
    const unreadCount = unreadByConversation[row.id] ?? 0;

    const buyerName = userNameById[row.buyer_id];
    const sellerName = userNameById[row.seller_id];
    const lastMessage = latestByConversation[row.id];

    return {
      id: row.id,
      listingId: row.listing_id,
      buyerId: row.buyer_id,
      sellerId: row.seller_id,
      buyerName,
      sellerName,
      sellerReplied: !!row.seller_replied,
      created_at: row.created_at,
      role,
      unreadCount,
      listingTitle: listingTitleById[row.listing_id],
      otherPartyName: role === "buyer" ? sellerName : buyerName,
      lastMessage: lastMessage?.text,
    };
  });

  return { conversations, totalUnread: conversations.reduce((sum, c) => sum + c.unreadCount, 0) };
}

async function reply(conversationId, userId, text) {
  const { rows } = await query("SELECT * FROM conversations WHERE id = $1", [conversationId]);
  const row = rows[0];
  if (!row) throw new MessageError(404, "Conversation not found.");
  const role = roleOf(row, userId);
  if (!role) throw new MessageError(403, "You're not part of this conversation.");
  if (!text?.trim()) throw new MessageError(400, "text is required.");
  if (text.trim().length > LIMITS.messageLength) {
    throw new MessageError(400, `Messages must be ${LIMITS.messageLength} characters or fewer.`);
  }

  // Also checked here, not just when starting a conversation - someone
  // may be blocked partway through an existing thread.
  if (await isBlockedBetween(row.buyer_id, row.seller_id)) {
    throw new MessageError(403, "You can no longer message in this conversation.");
  }

  await insertMessage(conversationId, { senderId: userId, senderType: role, text: text.trim() });
  await markRead(conversationId, role);

  if (role === "seller") {
    await query("UPDATE conversations SET seller_replied = true, ai_replied = true WHERE id = $1", [conversationId]);
  }

  const { rows: freshRows } = await query("SELECT * FROM conversations WHERE id = $1", [conversationId]);
  const thread = await serializeThread(freshRows[0], userId);

  const { rows: listingRows } = await query("SELECT * FROM listings WHERE id = $1", [row.listing_id]);
  const listing = listingRows[0];

  if (role === "buyer" && !row.seller_replied) {
    triggerAiReplyInBackground(conversationId, listing, text.trim());
  }

  notify({
    userId: role === "buyer" ? row.seller_id : row.buyer_id,
    type: "message_received",
    title: `New message about "${listing?.title ?? "your listing"}"`,
    body: text.trim().slice(0, 200),
    listingId: row.listing_id,
    conversationId,
  });

  return thread;
}

// (P1 #7) Paged message history for one conversation. Access is checked
// the same way as every other conversation operation - a cursor endpoint
// must not become a way to read threads you're not part of.
async function listMessages(conversationId, userId, { before, limit } = {}) {
  const { rows } = await query("SELECT * FROM conversations WHERE id = $1", [conversationId]);
  const row = rows[0];
  if (!row) throw new MessageError(404, "Conversation not found.");
  if (!roleOf(row, userId)) throw new MessageError(403, "You're not part of this conversation.");

  return getMessages(conversationId, { before, limit });
}

async function markConversationRead(conversationId, userId) {
  const { rows } = await query("SELECT * FROM conversations WHERE id = $1", [conversationId]);
  const row = rows[0];
  if (!row) throw new MessageError(404, "Conversation not found.");
  const role = roleOf(row, userId);
  if (!role) throw new MessageError(403, "You're not part of this conversation.");
  await markRead(conversationId, role);
  const { rows: freshRows } = await query("SELECT * FROM conversations WHERE id = $1", [conversationId]);
  return serializeThread(freshRows[0], userId);
}

// --- Listing-scoped: find/start "my conversation about this listing" ------

async function getThread(listingId, buyerId) {
  const { rows } = await query("SELECT * FROM conversations WHERE listing_id = $1 AND buyer_id = $2", [listingId, buyerId]);
  if (!rows[0]) return null;
  await markRead(rows[0].id, "buyer");
  const { rows: freshRows } = await query("SELECT * FROM conversations WHERE id = $1", [rows[0].id]);
  return serializeThread(freshRows[0], buyerId);
}

async function sendBuyerMessage(listingId, buyerId, text) {
  if (!text?.trim()) throw new MessageError(400, "text is required.");
  if (text.trim().length > LIMITS.messageLength) {
    throw new MessageError(400, `Messages must be ${LIMITS.messageLength} characters or fewer.`);
  }

  const { rows: listingRows } = await query("SELECT * FROM listings WHERE id = $1", [listingId]);
  const listing = listingRows[0];
  if (!listing) throw new MessageError(404, "Listing not found.");
  if (listing.seller_id === buyerId) throw new MessageError(400, "You can't message your own listing.");

  // Blocking is symmetric: if either party has blocked the other, neither
  // can start or continue this conversation. A one-way check would only
  // stop the person who didn't want contact in the first place.
  if (await isBlockedBetween(buyerId, listing.seller_id)) {
    throw new MessageError(403, "You can't message this seller.");
  }

  const convo = await getOrCreateConversation(listing, buyerId);
  const sellerAlreadyReplied = convo.seller_replied;
  await insertMessage(convo.id, { senderId: buyerId, senderType: "buyer", text: text.trim() });
  await markRead(convo.id, "buyer");

  const { rows: freshRows } = await query("SELECT * FROM conversations WHERE id = $1", [convo.id]);
  const thread = await serializeThread(freshRows[0], buyerId);

  if (!sellerAlreadyReplied) triggerAiReplyInBackground(convo.id, listing, text.trim());

  // Fire-and-forget: the seller has no other way to learn someone asked
  // about their item unless they happen to open the app.
  notify({
    userId: listing.seller_id,
    type: "message_received",
    title: `New message about "${listing.title}"`,
    body: text.trim().slice(0, 200),
    listingId: listing.id,
    conversationId: convo.id,
  });

  return thread;
}

module.exports = { MessageError, getMessages, listMessages, runAiReplyForJob, MESSAGE_PAGE_SIZE, myConversations, reply, markConversationRead, getThread, sendBuyerMessage };
