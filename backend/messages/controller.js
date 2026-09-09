const messagesService = require("../services/messagesService");

function handleServiceError(res, e) {
  if (e instanceof messagesService.MessageError) return res.status(e.status).json({ error: e.message });
  throw e;
}

async function myConversations(req, res) {
  try {
    res.json(await messagesService.myConversations(req.user.id));
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function reply(req, res) {
  try {
    const conversation = await messagesService.reply(req.params.id, req.user.id, req.body.text);
    res.status(201).json({ conversation });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function listMessages(req, res) {
  try {
    const page = await messagesService.listMessages(req.params.id, req.user.id, {
      before: req.query.cursor,
      limit: req.query.limit,
    });
    res.json(page);
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function markRead(req, res) {
  try {
    const conversation = await messagesService.markConversationRead(req.params.id, req.user.id);
    res.json({ conversation });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function getThread(req, res) {
  try {
    if (!req.query.listingId) return res.status(400).json({ error: "listingId is required." });
    const conversation = await messagesService.getThread(req.query.listingId, req.user.id);
    res.json({ conversation });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function sendBuyerMessage(req, res) {
  try {
    if (!req.body.listingId) return res.status(400).json({ error: "listingId is required." });
    const conversation = await messagesService.sendBuyerMessage(req.body.listingId, req.user.id, req.body.text);
    res.status(201).json({ conversation });
  } catch (e) {
    handleServiceError(res, e);
  }
}

module.exports = { myConversations, reply, listMessages, markRead, getThread, sendBuyerMessage };
