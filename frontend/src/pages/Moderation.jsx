import { useState, useEffect, useCallback } from "react";
import { ShieldAlert } from "lucide-react";
import { moderationService } from "../services/moderation";
import { useAuth } from "../features/auth/hooks/useAuth";
import { useToast } from "../hooks/useToast";

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
  const { user } = useAuth();
  const { toast, showToast } = useToast();
  const [reports, setReports] = useState([]);
  const [status, setStatus] = useState("open");
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { reports } = await moderationService.listReports(status);
      setReports(reports);
      setDenied(false);
    } catch (e) {
      if (e.message?.includes("Moderator")) setDenied(true);
      else showToast(e.message);
    } finally {
      setLoading(false);
    }
  }, [status, showToast]);

  useEffect(() => { if (user) load(); }, [user, load]);

  async function act(fn, successMessage) {
    try {
      await fn();
      showToast(successMessage);
      await load();
    } catch (e) {
      showToast(e.message);
    }
  }

  if (!user) return <p className="muted p-6">Log in to view this page.</p>;
  if (denied) return <p className="muted p-6">You don&apos;t have moderator access.</p>;

  return (
    <section className="page-section">
      <h1 className="uk-display page-title"><ShieldAlert size={18} /> Moderation</h1>

      <div className="pill-row mb-4">
        {["open", "reviewing", "actioned", "dismissed"].map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`pill pill-toggle ${status === s ? "pill-active" : ""}`}
          >
            {s}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="muted">Loading...</p>
      ) : reports.length === 0 ? (
        <p className="muted">Nothing in the {status} queue.</p>
      ) : (
        <div className="inbox-list">
          {reports.map((r) => (
            <div key={r.id} className="inbox-item">
              <p className="inbox-item-title">
                {r.reason}
                {r.listing_title && <> · {r.listing_title}</>}
              </p>
              {r.detail && <p className="small">{r.detail}</p>}
              <p className="small">Reported by {r.reporter_name}</p>

              <div className="my-listing-actions mt-2">
                {r.listing_id && (
                  <button
                    onClick={() => act(
                      () => moderationService.takeDownListing(r.listing_id, `Report #${r.id}: ${r.reason}`),
                      "Listing taken down."
                    )}
                    className="btn btn-berry btn-sm"
                  >
                    Take down listing
                  </button>
                )}
                {r.listing_id && (
                  <button
                    onClick={() => act(() => moderationService.restoreListing(r.listing_id), "Listing restored.")}
                    className="btn btn-outline btn-sm"
                  >
                    Restore
                  </button>
                )}
                {r.status !== "actioned" && (
                  <button
                    onClick={() => act(() => moderationService.resolveReport(r.id, "actioned"), "Marked actioned.")}
                    className="btn btn-outline btn-sm"
                  >
                    Mark actioned
                  </button>
                )}
                {r.status !== "dismissed" && (
                  <button
                    onClick={() => act(() => moderationService.resolveReport(r.id, "dismissed"), "Dismissed.")}
                    className="btn btn-outline btn-sm"
                  >
                    Dismiss
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
