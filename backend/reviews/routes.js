const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const validateIdParams = require("../middleware/validateId");
const controller = require("./controller");

const router = express.Router();

router.get("/user/:userId", validateIdParams("userId"), controller.listForUser);
router.post("/", requireAuth, controller.create);

module.exports = router;
