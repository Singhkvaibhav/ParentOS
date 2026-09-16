// Thin HTTP layer - all the actual logic lives in services/listingsService.js.
const listingsService = require("../services/listingsService");
const { recordListingView } = require("../services/analyticsService");
const logger = require("../logger");

function handleServiceError(res, e) {
  if (e instanceof listingsService.ListingError) return res.status(e.status).json({ error: e.message, code: e.code });
  throw e;
}

async function list(req, res) {
  try {
    res.json(await listingsService.list(req.query));
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function getOne(req, res) {
  try {
    // req.user is set by optionalAuth - a moderated listing is visible to
    // its seller and to moderators, and 404s for everyone else.
    const listing = await listingsService.getOne(req.params.id, req.user?.id);
    res.json({ listing });

    // After the response: viewing a listing must never be slowed down or
    // failed by analytics bookkeeping.
    recordListingView(listing.id, req.user?.id, listing.seller_id).catch((e) =>
      logger.warn("listing_view_record_failed", { listingId: listing.id, err: e })
    );
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function mine(req, res) {
  try {
    res.json({ listings: await listingsService.mine(req.user.id) });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function create(req, res) {
  try {
    res.status(201).json({ listing: await listingsService.create(req.user.id, req.body) });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function update(req, res) {
  try {
    res.json({ listing: await listingsService.update(req.params.id, req.user.id, req.body) });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function remove(req, res) {
  try {
    await listingsService.remove(req.params.id, req.user.id);
    res.json({ ok: true });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function reserve(req, res) {
  try {
    res.json({ listing: await listingsService.reserve(req.params.id, req.user.id) });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function markSold(req, res) {
  try {
    res.json({ listing: await listingsService.markSold(req.params.id, req.user.id) });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function relist(req, res) {
  try {
    res.json({ listing: await listingsService.relist(req.params.id, req.user.id) });
  } catch (e) {
    handleServiceError(res, e);
  }
}

module.exports = { list, getOne, mine, create, update, remove, reserve, markSold, relist };
