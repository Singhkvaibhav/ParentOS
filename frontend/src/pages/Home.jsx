import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Leaf, MapPin, ShieldCheck, CreditCard } from "lucide-react";
import { useListings } from "../features/listings/hooks/useListings";
import { useFavorites } from "../features/listings/hooks/useFavorites";
import { useAuth } from "../features/auth/hooks/useAuth";
import ListingCard from "../features/listings/components/ListingCard";
import AuthModal from "../features/auth/components/AuthModal";

const RECENT_COUNT = 4;
// Never varies across renders, so this can be a plain module-level
// constant rather than a useMemo'd object recreated (with identical
// contents) on every render - useListings only needs a referentially
// stable object, which a module constant already is for free.
const HOME_FEED_FILTERS = { category: "all", condition: "all", q: "" };

export default function Home() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const favorites = useFavorites(!!user);
  const [authView, setAuthView] = useState(null);

  // Only ever renders RECENT_COUNT cards, so there's no reason to fetch a
  // full page (and pay for the joins/trust-score computation on every row)
  // just to slice most of it away.
  const { listings: recentListings, loading } = useListings(HOME_FEED_FILTERS, RECENT_COUNT);

  function toggleFavorite(listingId) {
    if (!user) { setAuthView("login"); return; }
    favorites.toggle(listingId);
  }

  return (
    <>
      <section className="hero">
        <div className="hero-content">
          <h1 className="uk-display hero-title">
            {t("home.heroTitle")}
          </h1>

          <p className="hero-subtitle">
            {t("home.heroSubtitle")}
          </p>

          <div className="hero-actions">
            <Link to="/marketplace" className="btn btn-paper">
              {t("home.browseListings")}
            </Link>

            <Link to="/marketplace?sell=1" className="btn btn-hero-outline">
              {t("home.sellAnItem")}
            </Link>
          </div>

          <div className="hero-benefits">
            <div className="hero-benefit">
              <Leaf className="hero-benefit-icon" aria-hidden="true" />
              <div>
                <strong>{t("home.benefitSustainableTitle")}</strong>
                <span>{t("home.benefitSustainableDesc")}</span>
              </div>
            </div>

            <div className="hero-benefit">
              <MapPin className="hero-benefit-icon" aria-hidden="true" />
              <div>
                <strong>{t("home.benefitLocalTitle")}</strong>
                <span>{t("home.benefitLocalDesc")}</span>
              </div>
            </div>

            <div className="hero-benefit">
              <ShieldCheck className="hero-benefit-icon" aria-hidden="true" />
              <div>
                <strong>{t("home.benefitTrustedTitle")}</strong>
                <span>{t("home.benefitTrustedDesc")}</span>
              </div>
            </div>

            <div className="hero-benefit">
              <CreditCard className="hero-benefit-icon" aria-hidden="true" />
              <div>
                <strong>{t("home.benefitSecureTitle")}</strong>
                <span>{t("home.benefitSecureDesc")}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="hero-image">
          <img
            src="/images/hero-nursery.jpg"
            alt={t("home.heroImageAlt")}
          />
        </div>
      </section>

      <section className="home-listings">
        <div className="home-section-header">
          <h2 className="uk-display">{t("home.recentlyListed")}</h2>

          <Link to="/marketplace" className="text-link">
            {t("home.seeAll")}
          </Link>
        </div>

        {loading ? (
          <p className="muted">{t("marketplace.loadingListings")}</p>
        ) : recentListings.length > 0 ? (
          <div className="listing-grid">
            {recentListings.map((item) => (
              <ListingCard
                key={item.id}
                listing={item}
                onClick={() => navigate(`/listing/${item.id}`)}
                favorited={favorites.isFavorited(item.id)}
                onToggleFavorite={() => toggleFavorite(item.id)}
              />
            ))}
          </div>
        ) : (
          <div className="home-empty-state">
            <p className="uk-display home-empty-title">
              {t("home.noListingsTitle")}
            </p>

            <p className="muted">
              {t("home.noListingsBody")}
            </p>

            <Link to="/marketplace?sell=1" className="btn btn-berry">
              {t("home.sellAnItemArrow")}
            </Link>
          </div>
        )}
      </section>

      {authView && <AuthModal initialView={authView} onClose={() => setAuthView(null)} showToast={() => {}} />}
    </>
  );
}
