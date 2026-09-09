const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const validateIdParams = require("../middleware/validateId");
const controller = require("./controller");

const router = express.Router();

router.get("/", requireAuth, controller.list);
router.post("/read-all", requireAuth, controller.markAllRead);
router.post("/:id/read", validateIdParams("id"), requireAuth, controller.markRead);
router.post("/email-preference", requireAuth, controller.setEmailPreference);

module.exports = router;
