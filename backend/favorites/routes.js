const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const validateIdParams = require("../middleware/validateId");
const controller = require("./controller");

const router = express.Router();

router.get("/", requireAuth, controller.list);
router.post("/", requireAuth, controller.add);
router.delete("/:listingId", validateIdParams("listingId"), requireAuth, controller.remove);

module.exports = router;
