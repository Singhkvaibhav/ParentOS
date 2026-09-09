import { useState } from "react";
import { Link } from "react-router-dom";
import { X, MapPin, MessageCircle, CheckCircle2, Heart, ShoppingBag, Flag } from "lucide-react";
import { categoryMeta, sizeLabelFor } from "../../../constants";
import { formatEuro } from "../../../utils";
import ChatThread from "../../messaging/components/ChatThread";
import Checkout from "../../orders/components/Checkout";
import ReportDialog from "../../moderation/components/ReportDialog";
import TrustBadge from "../../profile/components/TrustBadge";
import { useBuyerThread } from "../../messaging/hooks/useMessages";
import { useAuth } from "../../auth/hooks/useAuth";

export default function ListingDetails({ listing, onClose, showToast, onRequireLogin, favorites }) {
  const { user } = useAuth();
  const { conversation, send, aiTyping } = useBuyerThread(listing.id, !!user);
  const [showCheckout, setShowCheckout] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const Icon = categoryMeta(listing.category).icon;
  const isOwnListing = user && user.id === listing.seller_id;
  const favorited = favorites?.isFavorited?.(listing.id);

  function handleFavorite() {
    if (!user) { onRequireLogin(); return; }
    favorites.toggle(listing.id);
  }

  function handleBuy() {
    if (!user) { onRequireLogin(); return; }
    setShowCheckout(true);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="uk-display modal-title">{listing.title}</h2>
          <div className="flex" style={{ gap: "0.5rem" }}>
            <button onClick={handleFavorite} aria-label="Favorite" className="icon-button">
              <Heart size={18} fill={favorited ? "var(--berry)" : "none"} color={favorited ? "var(--berry)" : "currentColor"} />
            </button>
            <button onClick={onClose} aria-label="Close"><X size={20} /></button>
          </div>
        </div>

        <div className="listing-detail-image">
          {listing.photo_url ? <img src={listing.photo_url} alt={listing.title} /> : <Icon size={40} style={{ color: "var(--moss-dark)" }} />}
        </div>

        <p className="uk-display listing-detail-price">{formatEuro(listing.price_cents)}</p>

        <div className="pill-row">
          <span className="pill">{sizeLabelFor(listing.category)}: {listing.size_or_age || listing.sizeOrAge}</span>
          <span className="pill">{listing.condition}</span>
          <span className="pill"><MapPin size={12} /> {listing.area}, {listing.city} &middot; {listing.pincode}</span>
          {listing.distanceKm != null && <span className="pill">{listing.distanceKm.toFixed(1)} km away</span>}
        </div>

        <p className="listing-detail-description">{listing.description}</p>
        <p className="listing-detail-seller">
          Listed by <Link to={`/seller/${listing.seller_id}`} className="link-button">{listing.seller_name}</Link>
          {listing.seller_verified && <CheckCircle2 size={13} style={{ color: "var(--moss)" }} />}
          {listing.sellerTrust && <TrustBadge trust={listing.sellerTrust} />}
        </p>

        {!isOwnListing && (
          <button
            onClick={() => (user ? setShowReport(true) : onRequireLogin())}
            className="link-button report-link"
          >
            <Flag size={12} /> Report this listing
          </button>
        )}

        {!isOwnListing && listing.status === "active" && (
          <button onClick={handleBuy} className="btn btn-berry btn-block mb-4">
            <ShoppingBag size={16} /> Buy now
          </button>
        )}
        {!isOwnListing && listing.status !== "active" && (
          <p className="small mb-4">This item is {listing.status === "reserved" ? "reserved" : "no longer available"}.</p>
        )}

        {!isOwnListing && (
          <div className="modal-divider">
            <p className="chat-label"><MessageCircle size={14} /> Message the seller</p>
            {!user ? (
              <button onClick={onRequireLogin} className="btn btn-moss">Log in to message the seller</button>
            ) : (
              <ChatThread conversation={conversation} listing={listing} role="buyer" aiTyping={aiTyping} onSend={send} />
            )}
          </div>
        )}
      </div>

      {showCheckout && <Checkout listing={listing} onClose={() => setShowCheckout(false)} showToast={showToast} />}
      {showReport && (
        <ReportDialog
          target={{ listingId: listing.id }}
          onClose={() => setShowReport(false)}
          showToast={showToast}
        />
      )}
    </div>
  );
}
