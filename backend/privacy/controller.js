const privacyService = require("../services/privacyService");

function handleServiceError(res, e) {
  if (e instanceof privacyService.PrivacyError) return res.status(e.status).json({ error: e.message });
  throw e;
}

// Article 15/20: served as a downloadable JSON file rather than a plain
// response body, because "machine-readable format" means the user should
// get a file they can keep or hand to another service.
async function exportData(req, res) {
  try {
    const data = await privacyService.exportUserData(req.user.id);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="uusiksi-data-${req.user.id}.json"`);
    res.send(JSON.stringify(data, null, 2));
  } catch (e) {
    handleServiceError(res, e);
  }
}

// Shown before the confirmation step, so a user learns their account can't
// be deleted yet BEFORE typing their email to confirm it.
async function deletionStatus(req, res) {
  res.json({ blockers: await privacyService.deletionBlockers(req.user.id) });
}

async function deleteAccount(req, res) {
  try {
    const result = await privacyService.deleteAccount(req.user.id, req.body);
    res.clearCookie("parentos_session");
    res.json(result);
  } catch (e) {
    handleServiceError(res, e);
  }
}

module.exports = { exportData, deletionStatus, deleteAccount };
