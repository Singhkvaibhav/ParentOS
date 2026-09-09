const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const controller = require("./controller");

const router = express.Router();

router.post("/onboard", requireAuth, controller.onboard);
router.get("/status", requireAuth, controller.status);

module.exports = router;
