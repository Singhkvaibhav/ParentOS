const favoritesService = require("../services/favoritesService");

async function list(req, res) {
  res.json({ favorites: await favoritesService.list(req.user.id) });
}

async function add(req, res) {
  if (!req.body.listingId) return res.status(400).json({ error: "listingId is required." });
  try {
    await favoritesService.add(req.user.id, req.body.listingId);
    res.status(201).json({ ok: true });
  } catch (e) {
    if (e instanceof favoritesService.FavoriteError) return res.status(e.status).json({ error: e.message, code: e.code });
    throw e;
  }
}

async function remove(req, res) {
  await favoritesService.remove(req.user.id, req.params.listingId);
  res.json({ ok: true });
}

module.exports = { list, add, remove };
