const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const validateIdParams = require("../middleware/validateId");
const controller = require("./controller");

const router = express.Router();

// Anyone signed in can report or block.
router.post("/reports", requireAuth, controller.createReport);
router.post("/blocks", requireAuth, controller.blockUser);
router.get("/blocks", requireAuth, controller.listBlocks);
router.delete("/blocks/:userId", validateIdParams("userId"), requireAuth, controller.unblockUser);

// Moderator-only. The admin check lives in the service (requireAdmin)
// rather than here, so it can't be bypassed by any other caller reaching
// the same function.
router.get("/reports", requireAuth, controller.listReports);
router.post("/reports/:id/resolve", validateIdParams("id"), requireAuth, controller.resolveReport);
router.post("/listings/:id/takedown", validateIdParams("id"), requireAuth, controller.takeDownListing);
router.get("/unsettled", requireAuth, controller.listUnsettled);
router.post("/unsettled/:id/retry", validateIdParams("id"), requireAuth, controller.retryTakedown);
router.post("/listings/:id/restore", validateIdParams("id"), requireAuth, controller.restoreListing);

module.exports = router;
