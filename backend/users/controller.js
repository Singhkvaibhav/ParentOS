const usersService = require("../services/usersService");

async function getPublic(req, res) {
  try {
    res.json({ user: await usersService.getPublicProfile(req.params.id) });
  } catch (e) {
    if (e instanceof usersService.UserError) return res.status(e.status).json({ error: e.message, code: e.code });
    throw e;
  }
}

module.exports = { getPublic };
