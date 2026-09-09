import { ShieldCheck, Star } from "lucide-react";

// Shows a seller's trust signals as separate facts rather than one opaque
// score - see backend/services/trustService.js for why. A buyer can act on
// "12 sales, 4.8 from 9 reviews"; they can't act on "87% trusted".
const LEVEL_LABELS = {
  established: "Established seller",
  trusted: "Trusted seller",
  active: null, // no badge - the sale count speaks for itself
  new: null,
  unverified: null,
};

export default function TrustBadge({ trust, compact = false }) {
  if (!trust) return null;

  const badge = LEVEL_LABELS[trust.level];
  const parts = [];

  if (trust.completedSales > 0) {
    parts.push(`${trust.completedSales} ${trust.completedSales === 1 ? "sale" : "sales"}`);
  }
  if (trust.averageRating != null) {
    parts.push(`${trust.averageRating}★ (${trust.ratingCount})`);
  } else if (trust.ratingCount > 0) {
    // Honest about having reviews without implying a score we don't
    // consider reliable yet.
    parts.push(`${trust.ratingCount} ${trust.ratingCount === 1 ? "review" : "reviews"}`);
  }

  if (!badge && parts.length === 0) {
    return compact ? null : <span className="small">New seller</span>;
  }

  return (
    <span className="trust-badge">
      {badge && (
        <span className="trust-badge-level">
          <ShieldCheck size={12} /> {badge}
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
