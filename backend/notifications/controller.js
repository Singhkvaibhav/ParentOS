const notificationsService = require("../services/notificationsService");
const pushService = require("../services/pushService");

function handleServiceError(res, e) {
  if (e instanceof notificationsService.NotificationError) return res.status(e.status).json({ error: e.message, code: e.code });
  if (e instanceof pushService.PushError) return res.status(e.status).json({ error: e.message, code: e.code });
  throw e;
}

async function list(req, res) {
  const unreadOnly = req.query.unreadOnly === "true";
  res.json(await notificationsService.list(req.user.id, { unreadOnly, limit: req.query.limit }));
}

async function markRead(req, res) {
  try {
    await notificationsService.markRead(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function markAllRead(req, res) {
  await notificationsService.markAllRead(req.user.id);
  res.json({ ok: true });
}

async function setEmailPreference(req, res) {
  await notificationsService.setEmailPreference(req.user.id, req.body.enabled);
  res.json({ ok: true });
}

async function registerPushToken(req, res) {
  try {
    await pushService.registerToken(req.user.id, req.body?.token, req.body?.platform);
    res.json({ ok: true });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function unregisterPushToken(req, res) {
  await pushService.unregisterToken(req.user.id, req.body?.token);
  res.json({ ok: true });
}

module.exports = { list, markRead, markAllRead, setEmailPreference, registerPushToken, unregisterPushToken };
