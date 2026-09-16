const analyticsService = require("../services/analyticsService");

function handleServiceError(res, e) {
  if (e instanceof analyticsService.AnalyticsError) return res.status(e.status).json({ error: e.message, code: e.code });
  throw e;
}

async function sellerStats(req, res) {
  res.json({ stats: await analyticsService.sellerStats(req.user.id) });
}

async function listingStats(req, res) {
  try {
    res.json({ stats: await analyticsService.listingStats(req.params.id, req.user.id) });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function platformStats(req, res) {
  try {
    res.json({ stats: await analyticsService.platformStats(req.user.id) });
  } catch (e) {
    handleServiceError(res, e);
  }
}

module.exports = { sellerStats, listingStats, platformStats };
