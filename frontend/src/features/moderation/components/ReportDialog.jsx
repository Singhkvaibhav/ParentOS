import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Flag } from "lucide-react";
import { moderationService } from "../../../services/moderation";
import { translateServerError } from "../../../i18n/errorMessages";

// Reasons mirror the CHECK constraint in migration 005. "safety" is first
// deliberately - for a marketplace selling children's items, an unsafe or
// recalled product is the report that matters most, and burying it under
// spam would be the wrong default.
const REASONS = [
  { id: "safety", key: "report.reasonSafety" },
  { id: "prohibited", key: "report.reasonProhibited" },
  { id: "misleading", key: "report.reasonMisleading" },
  { id: "harassment", key: "report.reasonHarassment" },
  { id: "spam", key: "report.reasonSpam" },
  { id: "other", key: "report.reasonOther" },
];

export default function ReportDialog({ target, onClose, showToast }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("safety");
  const [detail, setDetail] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    try {
      await moderationService.report({ ...target, reason, detail: detail.trim() || undefined });
      showToast(t("report.thanks"));
      onClose();
    } catch (e) {
      showToast(translateServerError(e.message, t));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-sheet modal-sheet-small" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="uk-display modal-title"><Flag size={16} /> {t("report.title")}</h2>
          <button onClick={onClose} aria-label={t("listingDetails.closeAria")}><X size={20} /></button>
        </div>

        <div className="form-stack">
          <p className="field-label">{t("report.whatsWrong")}</p>
          {REASONS.map((r) => (
            <label key={r.id} className="report-reason">
              <input
                type="radio"
                name="report-reason"
                value={r.id}
                checked={reason === r.id}
                onChange={() => setReason(r.id)}
              />
              {t(r.key)}
            </label>
          ))}

          <p className="field-label">{t("report.anythingElse")}</p>
          <textarea
            className="input textarea"
            rows={3}
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            maxLength={2000}
            placeholder={t("report.detailPlaceholder")}
          />

          <button onClick={submit} disabled={submitting} className="btn btn-berry btn-block">
            {submitting ? t("report.sending") : t("report.send")}
          </button>
        </div>
      </div>
    </div>
  );
}
