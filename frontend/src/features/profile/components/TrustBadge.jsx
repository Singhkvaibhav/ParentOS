import { useTranslation } from "react-i18next";
import { ShieldCheck, Star } from "lucide-react";

// Shows a seller's trust signals as separate facts rather than one opaque
// score - see backend/services/trustService.js for why. A buyer can act on
// "12 sales, 4.8 from 9 reviews"; they can't act on "87% trusted".
const LEVEL_KEYS = {
  established: "trust.established",
  trusted: "trust.trusted",
  active: null, // no badge - the sale count speaks for itself
  new: null,
  unverified: null,
};

export default function TrustBadge({ trust, compact = false }) {
  const { t } = useTranslation();
  if (!trust) return null;

  const badgeKey = LEVEL_KEYS[trust.level];
  const parts = [];

  if (trust.completedSales > 0) {
    parts.push(t("trust.sale", { count: trust.completedSales }));
  }
  if (trust.averageRating != null) {
    parts.push(`${trust.averageRating}★ (${trust.ratingCount})`);
  } else if (trust.ratingCount > 0) {
    // Honest about having reviews without implying a score we don't
    // consider reliable yet.
    parts.push(t("trust.review", { count: trust.ratingCount }));
  }

  if (!badgeKey && parts.length === 0) {
    return compact ? null : <span className="small">{t("trust.newSeller")}</span>;
  }

  return (
    <span className="trust-badge">
      {badgeKey && (
        <span className="trust-badge-level">
          <ShieldCheck size={12} /> {t(badgeKey)}
        </span>
      )}
      {parts.length > 0 && (
        <span className="small">
          {trust.averageRating != null && <Star size={11} fill="currentColor" />} {parts.join(" · ")}
        </span>
      )}
    </span>
  );
}
