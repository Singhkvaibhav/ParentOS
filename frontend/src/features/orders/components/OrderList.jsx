import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatEuro } from "../../../utils";
import { useOrders } from "../hooks/useOrders";
import { translateServerError } from "../../../i18n/errorMessages";

// The user's purchases and sales, with the lifecycle actions each side can
// take. Owns its own data via useOrders rather than receiving it, so the
// page composing it doesn't have to know that orders exist as a concept.
export default function OrderList({ enabled, showToast }) {
  const { t } = useTranslation();
  const { orders, confirmReceipt, markFulfilled, raiseDispute } = useOrders(enabled);
  const [disputingId, setDisputingId] = useState(null);
  const [disputeReason, setDisputeReason] = useState("");

  async function run(fn) {
    try {
      await fn();
    } catch (e) {
      showToast(translateServerError(e, t));
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
      <h2 className="uk-display page-title mt-5">{t("orders.title")}</h2>
      <div className="my-listings">
        {orders.map((order) => (
          <div key={order.id} className="my-listing-row">
            <div className="my-listing-info">
              <p className="my-listing-title">
                {order.listingTitle}
                <span className={`role-badge role-${order.role}`}>{order.role === "buyer" ? t("orders.bought") : t("orders.sold")}</span>
              </p>
              <p className="small">
                {t("orders.totalDelivery", { amount: formatEuro(order.total_amount_cents), method: order.delivery_method })}
                {order.role === "seller" && t("orders.commission", { amount: formatEuro(order.commission_amount_cents) })}
                {" · "}{t(`orders.status.${order.status}`, { defaultValue: order.status })}
              </p>

              <div className="my-listing-actions mt-2">
                {/* Seller says they've handed it over. This endpoint has
                    existed since the lifecycle round but had no UI, so
                    'fulfilled' was unreachable in practice. */}
                {order.role === "seller" && order.status === "paid" && (
                  <button onClick={() => run(() => markFulfilled(order.id))} className="btn btn-outline btn-sm">
                    {t("orders.handedOver")}
                  </button>
                )}

                {/* Buyer confirms receipt - the only transition that can
                    close an order, since only they can attest to it. */}
                {order.role === "buyer" && ["paid", "fulfilled"].includes(order.status) && (
                  <button onClick={() => run(() => confirmReceipt(order.id))} className="btn btn-moss btn-sm">
                    {t("orders.received")}
                  </button>
                )}

                {/* Either party can flag a problem - a buyer falsely
                    claiming non-delivery harms a seller just as much. */}
                {["paid", "fulfilled", "completed"].includes(order.status) && disputingId !== order.id && (
                  <button onClick={() => setDisputingId(order.id)} className="link-button">
                    {t("orders.somethingWrong")}
                  </button>
                )}

                {order.status === "completed" && (
                  <span className="small">{t("orders.completedReview")}</span>
                )}
                {order.status === "disputed" && (
                  <span className="small">{t("orders.reportedInTouch")}</span>
                )}
              </div>

              {disputingId === order.id && (
                <div className="form-stack mt-2">
                  <textarea
                    className="input textarea"
                    rows={2}
                    maxLength={2000}
                    value={disputeReason}
                    onChange={(e) => setDisputeReason(e.target.value)}
                    placeholder={t("orders.whatWentWrong")}
                  />
                  <div className="my-listing-actions">
                    <button
                      onClick={() => submitDispute(order.id)}
                      disabled={!disputeReason.trim()}
                      className="btn btn-berry btn-sm"
                    >
                      {t("orders.reportProblem")}
                    </button>
                    <button onClick={() => { setDisputingId(null); setDisputeReason(""); }} className="link-button">
                      {t("orders.cancel")}
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
