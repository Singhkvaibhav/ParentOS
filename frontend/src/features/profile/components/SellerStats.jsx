import { useState, useEffect } from "react";
import { Eye, MessageCircle, Package, Wallet } from "lucide-react";
import { analyticsService } from "../../../services/analytics";
import { formatEuro } from "../../../utils";

// A seller's own performance. The pairing of views WITH conversations and
// sales is the point: views alone can't distinguish "nobody is finding
// this" from "people look and don't buy", and those need opposite fixes
// (reach vs price/photos).
export default function SellerStats() {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    let cancelled = false;
    analyticsService.me()
      .then((d) => { if (!cancelled) setStats(d.stats); })
      .catch(() => { /* stats are supplementary - never block the profile */ });
    return () => { cancelled = true; };
  }, []);

  if (!stats) return null;

  const items = [
    { icon: Eye, label: "Views", value: stats.totalViews },
    { icon: MessageCircle, label: "Conversations", value: stats.conversations },
    { icon: Package, label: "Sold", value: stats.completedSales },
    { icon: Wallet, label: "Earned", value: formatEuro(stats.netEarnedCents) },
  ];

  return (
    <>
      <h2 className="uk-display page-title mt-5">Your activity</h2>
      <div className="seller-stats">
        {items.map(({ icon: Icon, label, value }) => (
          <div key={label} className="seller-stat">
            <Icon size={14} />
            <span className="seller-stat-value">{value}</span>
            <span className="small">{label}</span>
          </div>
        ))}
      </div>
      {stats.viewToSaleRate != null && (
        <p className="small">{stats.viewToSaleRate}% of views became sales.</p>
      )}
      {stats.totalViews === 0 && stats.activeListings > 0 && (
        <p className="small">No views yet - it can take a little while for new listings to be found.</p>
      )}
    </>
  );
}
