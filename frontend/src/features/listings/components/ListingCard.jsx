import { useTranslation } from "react-i18next";
import { MapPin, Heart } from "lucide-react";
import TrustBadge from "../../profile/components/TrustBadge";
import { categoryMeta } from "../../../constants";
import { formatEuro } from "../../../utils";

function CategoryIcon({ category, size = 32, color = "var(--moss-dark)" }) {
  // Presentation lookup only - the category id itself came from the API.
  const Icon = categoryMeta(category).icon;
  return <Icon size={size} style={{ color }} />;
}

// `onToggleFavorite` is optional - a surface that hasn't wired up
// favorites (there currently isn't one, but nothing forces every future
// caller to) just doesn't get the heart, rather than crashing.
export default function ListingCard({ listing, onClick, favorited, onToggleFavorite }) {
  const { t } = useTranslation();
  return (
    <div className="uk-card listing-card">
      {/* The heart needs to sit visually on top of the card while staying
          a sibling of - not nested inside - the button that opens the
          listing, since a button inside a button is both invalid HTML and
          means a click on the heart also fires the outer card's onClick. */}
      <button type="button" onClick={onClick} className="listing-card-clickarea">
        <div className="listing-card-image">
          {listing.photo_url ? (
            <img src={listing.photo_url} alt={listing.title} />
          ) : (
            <CategoryIcon category={listing.category} />
          )}
          {listing.status && listing.status !== "active" && (
            <span className={`status-badge status-${listing.status}`} style={{ position: "absolute", top: "0.5rem", left: "0.5rem" }}>
              {listing.status === "reserved" ? t("listingCard.reserved") : t("listingCard.sold")}
            </span>
          )}
        </div>
        <div className="listing-card-body">
          <p className="uk-clamp2 listing-card-title">{listing.title}</p>
          <p className="listing-card-meta">{listing.size_or_age || listing.sizeOrAge}</p>
          <p className="listing-card-meta">
            <MapPin size={11} /> {listing.area}, {listing.city}
            {listing.distanceKm != null && (
              <span> &middot; {listing.distanceKm < 1 ? t("listingCard.underOneKm") : `${listing.distanceKm.toFixed(1)} km`}</span>
            )}
          </p>
          {listing.sellerTrust && (
            <div className="listing-card-meta">
              <TrustBadge trust={listing.sellerTrust} compact />
            </div>
          )}
          <div className="listing-card-footer">
            <span className="listing-card-price">{formatEuro(listing.price_cents)}</span>
            <span className="pill pill-muted">{t(`conditions.${listing.condition}`, { defaultValue: listing.condition })}</span>
          </div>
        </div>
      </button>

      {onToggleFavorite && (
        <button
          type="button"
          className="listing-card-favorite"
          onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
          aria-label={t("listingDetails.favoriteAria")}
          aria-pressed={!!favorited}
        >
          <Heart size={16} fill={favorited ? "var(--berry)" : "none"} color={favorited ? "var(--berry)" : "var(--ink)"} />
        </button>
      )}
    </div>
  );
}
