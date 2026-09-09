const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const validateIdParams = require("../middleware/validateId");
const { messageLimiter, aiPerUserLimiter, aiPerIpLimiter } = require("../middleware/rateLimit");
const controller = require("./controller");

const router = express.Router();

// Unified inbox - every conversation the current user is in, as buyer or
// seller, with per-role unread counts.
router.get("/conversations", requireAuth, controller.myConversations);
router.post("/conversations/:id/reply", validateIdParams("id"), requireAuth, messageLimiter, aiPerIpLimiter, aiPerUserLimiter, controller.reply);
// Paged history: GET /conversations/:id/messages?cursor=<id>&limit=
router.get("/conversations/:id/messages", validateIdParams("id"), requireAuth, controller.listMessages);
router.post("/conversations/:id/read", validateIdParams("id"), requireAuth, controller.markRead);

// Listing-scoped: find/start "my conversation about this specific listing"
// from the listing detail page.
router.get("/thread", requireAuth, controller.getThread);
router.post("/thread", requireAuth, messageLimiter, aiPerIpLimiter, aiPerUserLimiter, controller.sendBuyerMessage);

module.exports = router;
