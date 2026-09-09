const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const validateIdParams = require("../middleware/validateId");
const controller = require("./controller");

const router = express.Router();

// A seller's own performance.
router.get("/me", requireAuth, controller.sellerStats);
router.get("/listings/:id", validateIdParams("id"), requireAuth, controller.listingStats);

// Platform health. The admin check lives in the service, so it can't be
// bypassed by another caller reaching the same function.
router.get("/platform", requireAuth, controller.platformStats);

module.exports = router;
