const connectService = require("../services/connectService");

function handleServiceError(res, e) {
  if (e instanceof connectService.ConnectError) return res.status(e.status).json({ error: e.message, code: e.code });
  throw e;
}

async function onboard(req, res) {
  try {
    res.json(await connectService.onboard(req.user.id));
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function status(req, res) {
  try {
    res.json(await connectService.status(req.user.id));
  } catch (e) {
    handleServiceError(res, e);
  }
}

module.exports = { onboard, status };
