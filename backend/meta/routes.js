const express = require("express");
const { MARKETPLACE, CATEGORIES, CONDITIONS, LIMITS } = require("../config");

const router = express.Router();

// Public marketplace configuration, so the frontend renders from the same
// source of truth the API validates against instead of its own hardcoded
// copy. Without this, adding a category server-side but forgetting the
// frontend (or vice versa) silently produces listings that either can't be
// created or can't be filtered for.
//
// Deliberately exposes only what the UI legitimately needs - the delivery
// fee and limits it must display or enforce client-side. Commission is NOT
// included: it's a platform-internal number the buyer's UI has no reason
// to know, and the authoritative amounts always come back from the
// checkout response anyway.
router.get("/config", (req, res) => {
  res.json({
    categories: CATEGORIES,
    conditions: CONDITIONS,
    deliveryFeeCents: MARKETPLACE.deliveryFeeCents,
    maxPriceCents: MARKETPLACE.maxPriceCents,
    limits: {
      titleLength: LIMITS.titleLength,
      descriptionLength: LIMITS.descriptionLength,
      sizeOrAgeLength: LIMITS.sizeOrAgeLength,
    },
  });
});

module.exports = router;
