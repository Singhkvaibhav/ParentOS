const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const validateIdParams = require("../middleware/validateId");
const optionalAuth = require("../middleware/optionalAuth");
const controller = require("./controller");

const router = express.Router();

router.get("/", controller.list);
// optionalAuth so a view can be attributed (and a seller's own views
// skipped) without making the listing page require an account.
router.get("/:id", validateIdParams("id"), optionalAuth, controller.getOne);
router.post("/", requireAuth, controller.create);
router.patch("/:id", validateIdParams("id"), requireAuth, controller.update);
router.delete("/:id", validateIdParams("id"), requireAuth, controller.remove);
router.post("/:id/reserve", validateIdParams("id"), requireAuth, controller.reserve);
router.post("/:id/sold", validateIdParams("id"), requireAuth, controller.markSold);
router.post("/:id/relist", validateIdParams("id"), requireAuth, controller.relist);

module.exports = router;
