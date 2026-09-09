const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const validateIdParams = require("../middleware/validateId");
const controller = require("./controller");
const listingsController = require("../listings/controller");

const router = express.Router();

router.get("/me/listings", requireAuth, listingsController.mine);
router.get("/:id", validateIdParams("id"), controller.getPublic);

module.exports = router;
