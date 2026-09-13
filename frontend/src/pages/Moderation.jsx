import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ShieldAlert } from "lucide-react";
import { moderationService } from "../services/moderation";
import { useAuth } from "../features/auth/hooks/useAuth";
import { useToast } from "../hooks/useToast";
import { translateServerError } from "../i18n/errorMessages";

// The "Moderation" node of the admin journey. The backend has had a full
// report queue and takedown API for several rounds, but nothing in the app
// could reach it - a moderation system nobody can open isn't a moderation
// system.
//
// Authorization is the backend's job (the admin check lives in the
// service, not the route). This page just handles the 403 gracefully
// rather than reimplementing the check client-side, where it would be
// advisory at best.
export default function Moderation() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { toast, showToast } = useToast();
  const [reports, setReports] = useState([]);
  const [status, setStatus] = useState("open");
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(true);

  const STATUS_LABEL = {
    open: t("moderation.statusOpen"),
    reviewing: t("moderation.statusReviewing"),
    actioned: t("moderation.statusActioned"),
    dismissed: t("moderation.statusDismissed"),
  };
  const REASON_LABEL = {
    safety: t("report.reasonSafety"),
    prohibited: t("report.reasonProhibited"),
    misleading: t("report.reasonMisleading"),
    harassment: t("report.reasonHarassment"),
    spam: t("report.reasonSpam"),
    other: t("report.reasonOther"),
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { reports } = await moderationService.listReports(status);
      setReports(reports);
      setDenied(false);
    } catch (e) {
      if (e.message?.includes("Moderator")) setDenied(true);
      else showToast(translateServerError(e.message, t));
    } finally {
      setLoading(false);
    }
  }, [status, showToast, t]);

  useEffect(() => { if (user) load(); }, [user, load]);

  async function act(fn, successMessage) {
    try {
      await fn();
      showToast(successMessage);
      await load();
    } catch (e) {
      showToast(translateServerError(e.message, t));
    }
  }

  if (!user) return <p className="muted p-6">{t("moderation.loginPrompt")}</p>;
  if (denied) return <p className="muted p-6">{t("moderation.denied")}</p>;

  return (
    <section className="page-section">
      <h1 className="uk-display page-title"><ShieldAlert size={18} /> {t("moderation.title")}</h1>

      <div className="pill-row mb-4">
        {["open", "reviewing", "actioned", "dismissed"].map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`pill pill-toggle ${status === s ? "pill-active" : ""}`}
          >
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="muted">{t("common.loading")}</p>
      ) : reports.length === 0 ? (
        <p className="muted">{t("moderation.emptyQueue", { status: STATUS_LABEL[status] })}</p>
      ) : (
        <div className="inbox-list">
          {reports.map((r) => (
            <div key={r.id} className="inbox-item">
              <p className="inbox-item-title">
                {REASON_LABEL[r.reason] || r.reason}
                {r.listing_title && <> · {r.listing_title}</>}
              </p>
              {r.detail && <p className="small">{r.detail}</p>}
              <p className="small">{t("moderation.reportedBy", { name: r.reporter_name })}</p>

              <div className="my-listing-actions mt-2">
                {r.listing_id && (
                  <button
                    onClick={() => act(
                      () => moderationService.takeDownListing(r.listing_id, `Report #${r.id}: ${r.reason}`),
                      t("moderation.takenDownToast")
                    )}
                    className="btn btn-berry btn-sm"
                  >
                    {t("moderation.takeDown")}
                  </button>
                )}
                {r.listing_id && (
                  <button
                    onClick={() => act(() => moderationService.restoreListing(r.listing_id), t("moderation.restoredToast"))}
                    className="btn btn-outline btn-sm"
                  >
                    {t("moderation.restore")}
                  </button>
                )}
                {r.status !== "actioned" && (
                  <button
                    onClick={() => act(() => moderationService.resolveReport(r.id, "actioned"), t("moderation.actionedToast"))}
                    className="btn btn-outline btn-sm"
                  >
                    {t("moderation.markActioned")}
                  </button>
                )}
                {r.status !== "dismissed" && (
                  <button
                    onClick={() => act(() => moderationService.resolveReport(r.id, "dismissed"), t("moderation.dismissedToast"))}
                    className="btn btn-outline btn-sm"
                  >
                    {t("moderation.dismiss")}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </section>
  );
}
