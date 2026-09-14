import { useState, useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import SearchFilters from "../features/marketplace/components/SearchFilters";
import ListingGrid from "../features/listings/components/ListingGrid";
import ListingDetails from "../features/listings/components/ListingDetails";
import SellForm from "../features/listings/components/SellForm";
import AuthModal from "../features/auth/components/AuthModal";
import { useListings } from "../features/listings/hooks/useListings";
import { useLocation } from "../features/marketplace/hooks/useLocation";
import { useFavorites } from "../features/listings/hooks/useFavorites";
import { useAuth } from "../features/auth/hooks/useAuth";

export default function Marketplace({ showToast }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const favorites = useFavorites(!!user);
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeCategory, setActiveCategory] = useState("all");
  const [subcategoryFilter, setSubcategoryFilter] = useState("all");
  const [query, setQuery] = useState(searchParams.get("q") || "");
  const [conditionFilter, setConditionFilter] = useState("all");
  const [maxDistance, setMaxDistance] = useState("any");
  const [selected, setSelected] = useState(null);
  const [showSellForm, setShowSellForm] = useState(searchParams.get("sell") === "1");
  const [authView, setAuthView] = useState(null);

  const { refLocation, locating, useMyLocation, setManualArea, clear } = useLocation(showToast);

  const filters = useMemo(() => ({
    category: activeCategory,
    subcategory: subcategoryFilter,
    condition: conditionFilter,
    q: query,
    lat: refLocation?.lat,
    lng: refLocation?.lng,
    maxDistance: refLocation ? maxDistance : undefined,
  }), [activeCategory, subcategoryFilter, conditionFilter, query, refLocation, maxDistance]);

  const { listings, total, hasMore, loading, loadingMore, refresh, loadMore } = useListings(filters);

  const openSell = useCallback(() => {
    if (!user) { setAuthView("login"); showToast(t("marketplace.loginToSell")); return; }
    setShowSellForm(true);
  }, [user, showToast, t]);

  // Single entry point for both the quick category pills and the
  // CategoryMenu flyout, so picking a plain category (no subcategory)
  // always clears any subcategory left over from a previous selection -
  // otherwise switching from "Clothes > Baby" straight to "Toys" would
  // silently keep filtering on a subcategory that belongs to the wrong
  // category and return zero results with no visible reason why.
  const selectCategory = useCallback((category, subcategory) => {
    setActiveCategory(category);
    setSubcategoryFilter(subcategory || "all");
  }, []);

  const toggleFavorite = useCallback((listingId) => {
    if (!user) { setAuthView("login"); return; }
    favorites.toggle(listingId);
  }, [user, favorites]);

  return (
    <section className="listings-section">
      <div className="marketplace-intro">
        <h1 className="uk-display">{t("marketplace.title")}</h1>
        <p>
          {t("marketplace.subtitle")}
        </p>
      </div>

      <SearchFilters
        activeCategory={activeCategory} subcategoryFilter={subcategoryFilter} onSelectCategory={selectCategory}
        query={query} setQuery={setQuery}
        conditionFilter={conditionFilter} setConditionFilter={setConditionFilter}
        refLocation={refLocation} locating={locating} useMyLocation={useMyLocation}
        setManualArea={setManualArea} clearLocation={clear}
        maxDistance={maxDistance} setMaxDistance={setMaxDistance}
      />

      <div className="flex justify-end mb-4">
        <button onClick={openSell} className="btn btn-berry">{t("marketplace.sellAnItem")}</button>
      </div>

      <ListingGrid
        listings={listings} loading={loading} onSelect={setSelected}
        isFavorited={favorites.isFavorited} onToggleFavorite={toggleFavorite}
      />

      {!loading && listings.length > 0 && (
        <div className="pagination-footer">
          <p className="small">{t("marketplace.showingCount", { count: listings.length, total })}</p>
          {hasMore && (
            <button onClick={loadMore} disabled={loadingMore} className="btn btn-outline">
              {loadingMore ? t("marketplace.loadingMore") : t("marketplace.loadMore")}
            </button>
          )}
        </div>
      )}

      {selected && (
        <ListingDetails
          listing={selected}
          onClose={() => setSelected(null)}
          showToast={showToast}
          favorites={favorites}
          onRequireLogin={() => setAuthView("login")}
        />
      )}
      {showSellForm && user && (
        <SellForm onClose={() => { setShowSellForm(false); setSearchParams({}); }} onCreated={refresh} showToast={showToast} />
      )}
      {authView && <AuthModal initialView={authView} onClose={() => setAuthView(null)} showToast={showToast} />}
    </section>
  );
}
