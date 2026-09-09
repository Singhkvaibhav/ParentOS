const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const validateIdParams = require("../middleware/validateId");
const controller = require("./controller");

const router = express.Router();

// Admin-only throughout - the admin check lives in the service so it can't
// be bypassed by another caller reaching the same function.
router.get("/issues", requireAuth, controller.listIssues);
router.post("/issues/:id/resolve", validateIdParams("id"), requireAuth, controller.resolveIssue);
router.post("/run", requireAuth, controller.triggerRun);

module.exports = router;
