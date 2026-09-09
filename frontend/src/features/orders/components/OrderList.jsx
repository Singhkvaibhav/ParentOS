import { useState } from "react";
import { formatEuro } from "../../../utils";
import { useOrders } from "../hooks/useOrders";

// The user's purchases and sales, with the lifecycle actions each side can
// take. Owns its own data via useOrders rather than receiving it, so the
// page composing it doesn't have to know that orders exist as a concept.
export default function OrderList({ enabled, showToast }) {
  const { orders, confirmReceipt, markFulfilled, raiseDispute } = useOrders(enabled);
  const [disputingId, setDisputingId] = useState(null);
  const [disputeReason, setDisputeReason] = useState("");

  async function run(fn) {
    try {
      await fn();
    } catch (e) {
      showToast(e.message);
    }
  }

  async function submitDispute(id) {
    if (!disputeReason.trim()) return;
    await run(() => raiseDispute(id, disputeReason));
    setDisputingId(null);
    setDisputeReason("");
  }

  if (orders.length === 0) return null;

  return (
    <>
      <h2 className="uk-display page-title mt-5">Purchases &amp; sales</h2>
      <div className="my-listings">
        {orders.map((t) => (
          <div key={t.id} className="my-listing-row">
            <div className="my-listing-info">
              <p className="my-listing-title">
                {t.listingTitle}
                <span className={`role-badge role-${t.role}`}>{t.role === "buyer" ? "Bought" : "Sold"}</span>
              </p>
              <p className="small">
                {formatEuro(t.total_amount_cents)} total &middot; {t.delivery_method}
                {t.role === "seller" && ` \u00b7 commission ${formatEuro(t.commission_amount_cents)}`}
                {" \u00b7 "}{t.status}
              </p>

              <div className="my-listing-actions mt-2">
                {/* Seller says they've handed it over. This endpoint has
                    existed since the lifecycle round but had no UI, so
                    'fulfilled' was unreachable in practice. */}
                {t.role === "seller" && t.status === "paid" && (
                  <button onClick={() => run(() => markFulfilled(t.id))} className="btn btn-outline btn-sm">
                    I&apos;ve handed this over
                  </button>
                )}

                {/* Buyer confirms receipt - the only transition that can
                    close an order, since only they can attest to it. */}
                {t.role === "buyer" && ["paid", "fulfilled"].includes(t.status) && (
                  <button onClick={() => run(() => confirmReceipt(t.id))} className="btn btn-moss btn-sm">
                    I&apos;ve received this
                  </button>
                )}

                {/* Either party can flag a problem - a buyer falsely
                    claiming non-delivery harms a seller just as much. */}
                {["paid", "fulfilled", "completed"].includes(t.status) && disputingId !== t.id && (
                  <button onClick={() => setDisputingId(t.id)} className="link-button">
                    Something went wrong
                  </button>
                )}

                {t.status === "completed" && (
                  <span className="small">Completed &middot; you can leave a review</span>
                )}
                {t.status === "disputed" && (
                  <span className="small">Reported &middot; we&apos;ll be in touch</span>
                )}
              </div>

              {disputingId === t.id && (
                <div className="form-stack mt-2">
                  <textarea
                    className="input textarea"
                    rows={2}
                    maxLength={2000}
                    value={disputeReason}
                    onChange={(e) => setDisputeReason(e.target.value)}
                    placeholder="What went wrong?"
                  />
                  <div className="my-listing-actions">
                    <button
                      onClick={() => submitDispute(t.id)}
                      disabled={!disputeReason.trim()}
                      className="btn btn-berry btn-sm"
                    >
                      Report a problem
                    </button>
                    <button onClick={() => { setDisputingId(null); setDisputeReason(""); }} className="link-button">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
