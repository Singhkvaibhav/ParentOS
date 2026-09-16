import { useTranslation } from "react-i18next";
import { Search, MapPin, X } from "lucide-react";
import { CITIES, AREA_DATA, subcategoryLabel } from "../../../constants";
import { useMarketplaceConfig } from "../hooks/useMarketplaceConfig";
import CategoryMenu from "./CategoryMenu";

export default function SearchFilters({
  activeCategory, subcategoryFilter, onSelectCategory,
  query, setQuery,
  conditionFilter, setConditionFilter,
  refLocation, locating, useMyLocation, setManualArea, clearLocation,
  maxDistance, setMaxDistance,
}) {
  const { t } = useTranslation();
  // Browsing is a read path, so it tolerates the degraded fallback: a
  // stale filter value just returns nothing, it can't corrupt anything.
  const { categories, conditions, subcategoriesByCategory } = useMarketplaceConfig();

  // The category dropdown used to sit next to a full row of quick-pick
  // pills (All / Clothes / Accessories / Toys) that did the exact same
  // job - pick a top-level category - as a second, separate control. Now
  // there's one way to choose a category (the dropdown) and one place
  // that shows what's currently chosen: this chip, which doubles as the
  // "clear" affordance the pill row's active-highlight used to provide.
  const activeCategoryMeta = categories.find((c) => c.id === activeCategory);

  return (
    <div>
      <div className="pill-row mb-4">
        <CategoryMenu categories={categories} subcategoriesByCategory={subcategoriesByCategory} onSelect={onSelectCategory} />
        {activeCategoryMeta && (
          <span className="pill pill-active active-subcategory-pill">
            {activeCategoryMeta.icon && <activeCategoryMeta.icon size={14} />}
            {t(`categories.${activeCategoryMeta.id}`, { defaultValue: activeCategoryMeta.label })}
            <button type="button" onClick={() => onSelectCategory("all", null)} aria-label={t("filters.clear")}>
              <X size={12} />
            </button>
          </span>
        )}
        {subcategoryFilter && subcategoryFilter !== "all" && (
          <span className="pill pill-active active-subcategory-pill">
            {t(`subcategories.${activeCategory}.${subcategoryFilter}`, {
              defaultValue: subcategoryLabel(activeCategory, subcategoryFilter),
            })}
            <button type="button" onClick={() => onSelectCategory(activeCategory, null)} aria-label={t("filters.clear")}>
              <X size={12} />
            </button>
          </span>
        )}
      </div>

      <div className="filter-row">
        <div className="search-box">
          <Search size={16} style={{ color: "var(--stone)" }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("filters.searchPlaceholder")} className="search-input" />
        </div>
        <select value={conditionFilter} onChange={(e) => setConditionFilter(e.target.value)} className="select">
          <option value="all">{t("filters.anyCondition")}</option>
          {conditions.map((c) => <option key={c} value={c}>{t(`conditions.${c}`, { defaultValue: c })}</option>)}
        </select>
      </div>

      <div className="filter-row">
        <button onClick={useMyLocation} className={`pill pill-toggle ${refLocation?.label === "My location" ? "pill-active" : ""}`}>
          <MapPin size={14} /> {locating ? t("filters.locating") : t("filters.useMyLocation")}
        </button>
        <select
          value={refLocation?.key || ""}
          onChange={(e) => {
            if (!e.target.value) { clearLocation(); return; }
            const [c, a] = e.target.value.split("::");
            const loc = AREA_DATA[c].find((x) => x.area === a);
            setManualArea(loc.lat, loc.lng, `${loc.area}, ${c}`, e.target.value);
          }}
          className="select"
        >
          <option value="">{t("filters.pickArea")}</option>
          {CITIES.map((c) => (
            <optgroup key={c} label={c}>
              {AREA_DATA[c].map((a) => <option key={a.area} value={`${c}::${a.area}`}>{a.area}</option>)}
            </optgroup>
          ))}
        </select>
        <select value={maxDistance} onChange={(e) => setMaxDistance(e.target.value)} disabled={!refLocation} className="select">
          <option value="any">{t("filters.anyDistance")}</option>
          <option value="2">{t("filters.withinKm", { km: 2 })}</option>
          <option value="5">{t("filters.withinKm", { km: 5 })}</option>
          <option value="10">{t("filters.withinKm", { km: 10 })}</option>
        </select>
        {refLocation && <button onClick={clearLocation} className="link-button">{t("filters.clear")}</button>}
      </div>
      {!refLocation && <p className="muted small mb-4">{t("filters.setLocationHint")}</p>}
    </div>
  );
}
