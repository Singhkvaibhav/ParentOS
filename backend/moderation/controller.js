const moderationService = require("../services/moderationService");

function handleServiceError(res, e) {
  if (e instanceof moderationService.ModerationError) return res.status(e.status).json({ error: e.message, code: e.code });
  throw e;
}

async function createReport(req, res) {
  try {
    const report = await moderationService.createReport(req.user.id, req.body);
    res.status(201).json({ report });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function blockUser(req, res) {
  try {
    await moderationService.blockUser(req.user.id, req.body.userId);
    res.status(201).json({ ok: true });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function unblockUser(req, res) {
  try {
    await moderationService.unblockUser(req.user.id, req.params.userId);
    res.json({ ok: true });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function listBlocks(req, res) {
  res.json({ blocks: await moderationService.listBlocks(req.user.id) });
}

async function listReports(req, res) {
  try {
    res.json({ reports: await moderationService.listReports(req.user.id, req.query) });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function takeDownListing(req, res) {
  try {
    await moderationService.takeDownListing(req.user.id, req.params.id, req.body.reason);
    res.json({ ok: true });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function restoreListing(req, res) {
  try {
    await moderationService.restoreListing(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function resolveReport(req, res) {
  try {
    await moderationService.resolveReport(req.user.id, req.params.id, req.body);
    res.json({ ok: true });
  } catch (e) {
    handleServiceError(res, e);
  }
}

// Unfinished moderation means money that may be owed to a buyer, so it
// needs a surface a person actually looks at.
async function listUnsettled(req, res) {
  try {
    await moderationService.requireAdminForRequest(req.user.id);
    const { listUnsettled } = require("../services/moderationSagaService");
    res.json({ actions: await listUnsettled() });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function retryTakedown(req, res) {
  try {
    await moderationService.requireAdminForRequest(req.user.id);
    const { retryFailedTasks } = require("../services/moderationSagaService");
    res.json({ result: await retryFailedTasks(Number(req.params.id)) });
  } catch (e) {
    handleServiceError(res, e);
  }
}

module.exports = {
  listUnsettled,
  retryTakedown, createReport, blockUser, unblockUser, listBlocks, listReports, takeDownListing, restoreListing, resolveReport };
