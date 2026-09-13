import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Leaf, MapPin, ShieldCheck, CreditCard } from "lucide-react";
import { useListings } from "../features/listings/hooks/useListings";
import ListingCard from "../features/listings/components/ListingCard";

export default function Home() {
  const { t } = useTranslation();
  const filters = useMemo(
    () => ({
      category: "all",
      condition: "all",
      q: "",
    }),
    []
  );

  const { listings, loading } = useListings(filters);

  const recentListings = listings.slice(0, 4);

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
            src="/images/hero-nursery.png"
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
                onClick={() => {}}
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
    </>
  );
}
