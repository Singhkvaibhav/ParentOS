const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const controller = require("./controller");

const router = express.Router();

// All self-service: a user exercises their own rights without contacting
// support, which is what makes the right meaningful rather than nominal.
router.get("/export", requireAuth, controller.exportData);
router.get("/deletion-status", requireAuth, controller.deletionStatus);
router.post("/delete-account", requireAuth, controller.deleteAccount);

module.exports = router;
