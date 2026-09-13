import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { X, Truck, Package, CheckCircle2, MapPin } from "lucide-react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { formatEuro } from "../../../utils";
import { transactionsService } from "../../../services/transactions";
import { useMarketplaceConfig } from "../../marketplace/hooks/useMarketplaceConfig";
import { translateServerError } from "../../../i18n/errorMessages";

function PayButton({ amountLabel, onSuccess, onError }) {
  const { t } = useTranslation();
  const stripe = useStripe();
  const elements = useElements();
  const [paying, setPaying] = useState(false);

  async function handlePay() {
    if (!stripe || !elements) return;
    setPaying(true);
    const { error, paymentIntent } = await stripe.confirmPayment({ elements, redirect: "if_required" });
    setPaying(false);
    if (error) { onError(error.message); return; }
    if (paymentIntent?.status === "succeeded") onSuccess();
  }

  return (
    <button onClick={handlePay} disabled={!stripe || paying} className="btn btn-berry btn-block mt-4">
      {paying ? t("checkout.processing") : t("checkout.pay", { amount: amountLabel })}
    </button>
  );
}

// Real Stripe Elements checkout (test mode). Card details go straight to
// Stripe - they never touch our backend, which is the correct, PCI-safe way
// to do this. Requires STRIPE_PUBLISHABLE_KEY / STRIPE_SECRET_KEY to be set
// to your own (free) Stripe test keys - see the README.
//
// Three explicit steps, so the buyer always knows where they are and what
// happens next: choose delivery -> pay -> confirmation. The confirmation
// step matters most: previously a successful payment showed one line of
// text, leaving the buyer with no record of what they'd bought, what they
// paid, or how they'd receive it.
export default function Checkout({ listing, onClose, showToast }) {
  const { t } = useTranslation();
  const { deliveryFeeCents: configuredDeliveryFee } = useMarketplaceConfig();
  const [deliveryMethod, setDeliveryMethod] = useState("pickup");
  const [session, setSession] = useState(null); // { clientSecret, publishableKey, transaction }
  const [stripePromise, setStripePromise] = useState(null);
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);
  const [confirmed, setConfirmed] = useState(null); // payment accepted by Stripe
  // Settlement is a SEPARATE fact from payment: Stripe accepting the card
  // tells us nothing about whether the webhook has reached this backend and
  // moved the order out of 'pending'. Claiming "order confirmed" on the
  // strength of the client response would be asserting something we
  // haven't checked.
  const [settlement, setSettlement] = useState("waiting"); // waiting | settled | slow

  // Polls until the backend reports the order settled. Webhooks usually
  // arrive in seconds, but they can be delayed or retried, so this gives up
  // after a bounded wait and says so honestly rather than either spinning
  // forever or claiming a confirmation it never received.
  const pollForSettlement = useCallback(async (transactionId) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        const status = await transactionsService.status(transactionId);
        if (status.settled) { setSettlement("settled"); return; }
      } catch {
        // A failed poll is not evidence the order failed - keep trying
        // until the deadline.
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    // The money is taken either way; what is unconfirmed is the order
    // transition. Saying so is more useful than a spinner.
    setSettlement("slow");
  }, []);

  async function startCheckout() {
    setStarting(true);
    setError(null);
    try {
      const data = await transactionsService.checkout(listing.id, deliveryMethod);
      setSession(data);
      setStripePromise(loadStripe(data.publishableKey));
    } catch (e) {
      setError(translateServerError(e.message, t));
    } finally {
      setStarting(false);
    }
  }

  const deliveryFeeCents = deliveryMethod === "delivery" ? (configuredDeliveryFee ?? 0) : 0;
  const estimatedTotalCents = listing.price_cents + deliveryFeeCents;

  // Once checkout starts, the authoritative amounts come from the server's
  // response - never recomputed client-side, so what's displayed is always
  // exactly what's being charged.
  const order = session?.transaction;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-sheet modal-sheet-small" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="uk-display modal-title">
            {confirmed
              ? (settlement === "settled" ? t("checkout.orderConfirmed") : t("checkout.paymentReceived"))
              : session ? t("checkout.payment") : t("checkout.buyThisItem")}
          </h2>
          <button onClick={onClose} aria-label={t("listingDetails.closeAria")}><X size={20} /></button>
        </div>

        {confirmed ? (
          <div className="form-stack">
            <p className="checkout-confirmed">
              <CheckCircle2 size={18} />{" "}
              {settlement === "settled" ? t("checkout.orderConfirmed") : t("checkout.paymentReceived")}
            </p>

            {settlement === "waiting" && (
              <p className="small">{t("checkout.confirmingOrder")}</p>
            )}
            {settlement === "slow" && (
              <p className="small">
                {t("checkout.slowSettlement")}
              </p>
            )}

            <div className="profile-card">
              <p><strong>{listing.title}</strong></p>
              <p className="small">{t("checkout.orderNumber", { id: confirmed.id })}</p>
              <p className="small">{t("checkout.paid", { amount: formatEuro(confirmed.total_amount_cents) })}</p>
              <p className="small">
                {confirmed.delivery_method === "delivery" ? t("checkout.delivery") : t("checkout.pickup")}
                {confirmed.delivery_method === "pickup" && (
                  <> &middot; {listing.area}, {listing.city}</>
                )}
              </p>
            </div>

            <p className="small">
              {confirmed.delivery_method === "delivery"
                ? t("checkout.deliveryArrange", { seller: listing.seller_name })
                : t("checkout.pickupArrange", { seller: listing.seller_name, area: listing.area })}
            </p>
            <p className="small">{t("checkout.findOrderHint")}</p>

            <button onClick={onClose} className="btn btn-moss btn-block">{t("checkout.done")}</button>
          </div>
        ) : !session ? (
          <div className="form-stack">
            <p className="small">{listing.title}</p>
            <p className="field-label">{t("checkout.deliveryMethod")}</p>
            <div className="pill-row mb-4">
              <button onClick={() => setDeliveryMethod("pickup")} className={`pill pill-toggle ${deliveryMethod === "pickup" ? "pill-active" : ""}`}>
                <Package size={14} /> {t("checkout.pickupFree")}
              </button>
              <button onClick={() => setDeliveryMethod("delivery")} className={`pill pill-toggle ${deliveryMethod === "delivery" ? "pill-active" : ""}`}>
                <Truck size={14} /> {t("checkout.deliveryFee", { fee: formatEuro(configuredDeliveryFee ?? 0) })}
              </button>
            </div>

            {deliveryMethod === "pickup" && (
              <p className="small"><MapPin size={12} /> {t("checkout.collectFrom", { area: listing.area, city: listing.city })}</p>
            )}

            <div className="profile-card">
              <p className="small">{t("checkout.item", { amount: formatEuro(listing.price_cents) })}</p>
              <p className="small">{t("checkout.deliveryAmount", { amount: formatEuro(deliveryFeeCents) })}</p>
              <p><strong>{t("checkout.total", { amount: formatEuro(estimatedTotalCents) })}</strong></p>
            </div>

            {error && <p className="small" style={{ color: "var(--berry)" }}>{error}</p>}
            <button onClick={startCheckout} disabled={starting} className="btn btn-moss btn-block">
              {starting ? t("checkout.starting") : t("checkout.continueToPayment")}
            </button>
          </div>
        ) : (
          <div className="form-stack">
            {/* Amounts here come from the server's checkout response, so
                the buyer sees exactly what the PaymentIntent will charge. */}
            <div className="profile-card">
              <p className="small">{listing.title}</p>
              <p className="small">{t("checkout.item", { amount: formatEuro(order.item_amount_cents) })}</p>
              <p className="small">
                {order.delivery_method === "delivery" ? t("checkout.delivery") : t("checkout.pickup")}: {formatEuro(order.delivery_fee_cents)}
              </p>
              <p><strong>{t("checkout.total", { amount: formatEuro(order.total_amount_cents) })}</strong></p>
            </div>

            <Elements stripe={stripePromise} options={{ clientSecret: session.clientSecret }}>
              <PaymentElement />
              <PayButton
                amountLabel={formatEuro(order.total_amount_cents)}
                onSuccess={() => {
                  setConfirmed(order);
                  // Deliberately "Payment received", not "Order confirmed".
                  showToast(t("checkout.toastPaymentReceived"));
                  pollForSettlement(order.id);
                }}
                onError={(msg) => showToast(msg)}
              />
            </Elements>
          </div>
        )}
      </div>
    </div>
  );
}
