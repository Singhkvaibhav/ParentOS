const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const validateIdParams = require("../middleware/validateId");
const controller = require("./controller");

const router = express.Router();

router.post("/checkout", requireAuth, controller.checkout);
router.get("/mine", requireAuth, controller.mine);
// Buyer confirms the handover actually happened - see confirmReceipt.
router.post("/:id/confirm-receipt", validateIdParams("id"), requireAuth, controller.confirmReceipt);
// Seller marks the item handed over / posted.
router.post("/:id/fulfil", validateIdParams("id"), requireAuth, controller.markFulfilled);
// Either party can flag a problem - a seller can be wronged too.
// Admin-only: the parties disagree by definition, so neither can close it.
router.post("/:id/resolve-dispute", validateIdParams("id"), requireAuth, controller.resolveDispute);
router.post("/:id/dispute", validateIdParams("id"), requireAuth, controller.raiseDispute);
// Audit trail for one order - support and dispute evidence.
// Polled by the client after payment, to find out whether the WEBHOOK has
// settled the order - not merely whether Stripe accepted the card.
router.get("/:id/status", validateIdParams("id"), requireAuth, controller.orderStatus);
router.get("/:id/history", validateIdParams("id"), requireAuth, controller.history);
// Note: the webhook route itself is mounted separately in server.js, before
// the JSON body parser, because Stripe's signature check needs the raw body.

module.exports = router;
