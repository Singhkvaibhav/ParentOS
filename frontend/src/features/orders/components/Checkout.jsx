import { useState } from "react";
import { X, Truck, Package, CheckCircle2, MapPin } from "lucide-react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { formatEuro } from "../../../utils";
import { transactionsService } from "../../../services/transactions";
import { useMarketplaceConfig } from "../../marketplace/hooks/useMarketplaceConfig";

function PayButton({ amountLabel, onSuccess, onError }) {
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
      {paying ? "Processing..." : `Pay ${amountLabel}`}
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
  const { deliveryFeeCents: configuredDeliveryFee } = useMarketplaceConfig();
  const [deliveryMethod, setDeliveryMethod] = useState("pickup");
  const [session, setSession] = useState(null); // { clientSecret, publishableKey, transaction }
  const [stripePromise, setStripePromise] = useState(null);
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);
  const [confirmed, setConfirmed] = useState(null); // the completed order

  async function startCheckout() {
    setStarting(true);
    setError(null);
    try {
      const data = await transactionsService.checkout(listing.id, deliveryMethod);
      setSession(data);
      setStripePromise(loadStripe(data.publishableKey));
    } catch (e) {
      setError(e.message);
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
            {confirmed ? "Order confirmed" : session ? "Payment" : "Buy this item"}
          </h2>
          <button onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>

        {confirmed ? (
          <div className="form-stack">
            <p className="checkout-confirmed">
              <CheckCircle2 size={18} /> Payment received
            </p>

            <div className="profile-card">
              <p><strong>{listing.title}</strong></p>
              <p className="small">Order #{confirmed.id}</p>
              <p className="small">Paid: {formatEuro(confirmed.total_amount_cents)}</p>
              <p className="small">
                {confirmed.delivery_method === "delivery" ? "Delivery" : "Pickup"}
                {confirmed.delivery_method === "pickup" && (
                  <> &middot; {listing.area}, {listing.city}</>
                )}
              </p>
            </div>

            <p className="small">
              {confirmed.delivery_method === "delivery"
                ? `${listing.seller_name} will arrange delivery with you - use your messages to sort out the details.`
                : `Message ${listing.seller_name} to arrange a pickup time in ${listing.area}.`}
            </p>
            <p className="small">You can find this order any time under Purchases &amp; sales on your profile.</p>

            <button onClick={onClose} className="btn btn-moss btn-block">Done</button>
          </div>
        ) : !session ? (
          <div className="form-stack">
            <p className="small">{listing.title}</p>
            <p className="field-label">Delivery method</p>
            <div className="pill-row mb-4">
              <button onClick={() => setDeliveryMethod("pickup")} className={`pill pill-toggle ${deliveryMethod === "pickup" ? "pill-active" : ""}`}>
                <Package size={14} /> Pickup (free)
              </button>
              <button onClick={() => setDeliveryMethod("delivery")} className={`pill pill-toggle ${deliveryMethod === "delivery" ? "pill-active" : ""}`}>
                <Truck size={14} /> Delivery ({formatEuro(configuredDeliveryFee ?? 0)})
              </button>
            </div>

            {deliveryMethod === "pickup" && (
              <p className="small"><MapPin size={12} /> Collect from {listing.area}, {listing.city}</p>
            )}

            <div className="profile-card">
              <p className="small">Item: {formatEuro(listing.price_cents)}</p>
              <p className="small">Delivery: {formatEuro(deliveryFeeCents)}</p>
              <p><strong>Total: {formatEuro(estimatedTotalCents)}</strong></p>
            </div>

            {error && <p className="small" style={{ color: "var(--berry)" }}>{error}</p>}
            <button onClick={startCheckout} disabled={starting} className="btn btn-moss btn-block">
              {starting ? "Starting..." : "Continue to payment"}
            </button>
          </div>
        ) : (
          <div className="form-stack">
            {/* Amounts here come from the server's checkout response, so
                the buyer sees exactly what the PaymentIntent will charge. */}
            <div className="profile-card">
              <p className="small">{listing.title}</p>
              <p className="small">Item: {formatEuro(order.item_amount_cents)}</p>
              <p className="small">
                {order.delivery_method === "delivery" ? "Delivery" : "Pickup"}: {formatEuro(order.delivery_fee_cents)}
              </p>
              <p><strong>Total: {formatEuro(order.total_amount_cents)}</strong></p>
            </div>

            <Elements stripe={stripePromise} options={{ clientSecret: session.clientSecret }}>
              <PaymentElement />
              <PayButton
                amountLabel={formatEuro(order.total_amount_cents)}
                onSuccess={() => { setConfirmed(order); showToast("Payment successful!"); }}
                onError={(msg) => showToast(msg)}
              />
            </Elements>
          </div>
        )}
      </div>
    </div>
  );
}
