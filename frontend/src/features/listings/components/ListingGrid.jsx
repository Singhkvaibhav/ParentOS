import { useTranslation } from "react-i18next";
import ListingCard from "./ListingCard";

// isFavorited/onToggleFavorite are both optional - a caller that hasn't
// wired up favorites (or a logged-out view) just renders cards without
// the heart, rather than every ListingGrid usage needing to supply them.
export default function ListingGrid({ listings, loading, onSelect, isFavorited, onToggleFavorite }) {
  const { t } = useTranslation();
  if (loading) return <p className="muted">{t("marketplace.loadingListings")}</p>;
  if (listings.length === 0) {
    return (
      <div className="empty-state">
        <p className="uk-display empty-state-title">{t("marketplace.emptyTitle")}</p>
        <p className="muted">{t("marketplace.emptyBody")}</p>
      </div>
    );
  }
  return (
    <div className="listing-grid">
      {listings.map((item) => (
        <ListingCard
          key={item.id}
          listing={item}
          onClick={() => onSelect(item)}
          favorited={isFavorited?.(item.id)}
          onToggleFavorite={onToggleFavorite && (() => onToggleFavorite(item.id))}
        />
      ))}
    </div>
  );
}
