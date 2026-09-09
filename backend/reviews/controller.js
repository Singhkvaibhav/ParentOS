const reviewsService = require("../services/reviewsService");

async function listForUser(req, res) {
  res.json({ reviews: await reviewsService.listForUser(req.params.userId) });
}

async function create(req, res) {
  try {
    await reviewsService.create(req.user.id, req.body);
    res.status(201).json({ ok: true });
  } catch (e) {
    if (e instanceof reviewsService.ReviewError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
}

module.exports = { listForUser, create };
