const reconciliationService = require("../services/reconciliationService");

function handleServiceError(res, e) {
  if (e instanceof reconciliationService.ReconciliationError) {
    return res.status(e.status).json({ error: e.message });
  }
  throw e;
}

async function listIssues(req, res) {
  try {
    res.json(await reconciliationService.listIssues(req.user.id, req.query));
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function resolveIssue(req, res) {
  try {
    await reconciliationService.resolveIssue(req.user.id, req.params.id, req.body);
    res.json({ ok: true });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function triggerRun(req, res) {
  try {
    res.json({ result: await reconciliationService.triggerRun(req.user.id) });
  } catch (e) {
    handleServiceError(res, e);
  }
}

module.exports = { listIssues, resolveIssue, triggerRun };
