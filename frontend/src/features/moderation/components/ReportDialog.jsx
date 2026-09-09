import { useState } from "react";
import { X, Flag } from "lucide-react";
import { moderationService } from "../../../services/moderation";

// Reasons mirror the CHECK constraint in migration 005. "safety" is first
// deliberately - for a marketplace selling children's items, an unsafe or
// recalled product is the report that matters most, and burying it under
// spam would be the wrong default.
const REASONS = [
  { id: "safety", label: "Unsafe or recalled item" },
  { id: "prohibited", label: "Shouldn't be sold here" },
  { id: "misleading", label: "Description is misleading" },
  { id: "harassment", label: "Abusive behaviour" },
  { id: "spam", label: "Spam" },
  { id: "other", label: "Something else" },
];

export default function ReportDialog({ target, onClose, showToast }) {
  const [reason, setReason] = useState("safety");
  const [detail, setDetail] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    try {
      await moderationService.report({ ...target, reason, detail: detail.trim() || undefined });
      showToast("Thanks - this has been sent to our moderators.");
      onClose();
    } catch (e) {
      showToast(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-sheet modal-sheet-small" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="uk-display modal-title"><Flag size={16} /> Report</h2>
          <button onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>

        <div className="form-stack">
          <p className="field-label">What's wrong?</p>
          {REASONS.map((r) => (
            <label key={r.id} className="report-reason">
              <input
                type="radio"
                name="report-reason"
                value={r.id}
                checked={reason === r.id}
                onChange={() => setReason(r.id)}
              />
              {r.label}
            </label>
          ))}

          <p className="field-label">Anything else we should know? (optional)</p>
          <textarea
            className="input textarea"
            rows={3}
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            maxLength={2000}
            placeholder="e.g. the model number, what's unsafe about it"
          />

          <button onClick={submit} disabled={submitting} className="btn btn-berry btn-block">
            {submitting ? "Sending..." : "Send report"}
          </button>
        </div>
      </div>
    </div>
  );
}
