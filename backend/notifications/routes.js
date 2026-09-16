const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const validateIdParams = require("../middleware/validateId");
const controller = require("./controller");

const router = express.Router();

router.get("/", requireAuth, controller.list);
router.post("/read-all", requireAuth, controller.markAllRead);
router.post("/:id/read", validateIdParams("id"), requireAuth, controller.markRead);
router.post("/email-preference", requireAuth, controller.setEmailPreference);

// Push tokens: registered when the app gets OS-level permission and an
// Expo push token (see pushService.js) - no separate on/off preference the
// way email has one, since having a token at all already means the
// device's own permission prompt was granted.
router.post("/push-token", requireAuth, controller.registerPushToken);
router.delete("/push-token", requireAuth, controller.unregisterPushToken);

module.exports = router;
