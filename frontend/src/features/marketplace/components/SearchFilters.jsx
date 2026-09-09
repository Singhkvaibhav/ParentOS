import { Search, MapPin } from "lucide-react";
import { CITIES, AREA_DATA } from "../../../constants";
import { useMarketplaceConfig } from "../hooks/useMarketplaceConfig";

export default function SearchFilters({
  activeCategory, setActiveCategory,
  query, setQuery,
  conditionFilter, setConditionFilter,
  refLocation, locating, useMyLocation, setManualArea, clearLocation,
  maxDistance, setMaxDistance,
}) {
  // Browsing is a read path, so it tolerates the degraded fallback: a
  // stale filter value just returns nothing, it can't corrupt anything.
  const { categories, conditions } = useMarketplaceConfig();

  return (
    <div>
      <div className="pill-row mb-4">
        {[{ id: "all", label: "All", icon: null }, ...categories].map((cat) => {
          const active = activeCategory === cat.id;
          return (
            <button key={cat.id} onClick={() => setActiveCategory(cat.id)} className={`pill pill-toggle ${active ? "pill-active" : ""}`}>
              {cat.icon && <cat.icon size={14} />}{cat.label}
            </button>
          );
        })}
      </div>

      <div className="filter-row">
        <div className="search-box">
          <Search size={16} style={{ color: "var(--stone)" }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search listings..." className="search-input" />
        </div>
        <select value={conditionFilter} onChange={(e) => setConditionFilter(e.target.value)} className="select">
          <option value="all">Any condition</option>
          {conditions.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div className="filter-row">
        <button onClick={useMyLocation} className={`pill pill-toggle ${refLocation?.label === "My location" ? "pill-active" : ""}`}>
          <MapPin size={14} /> {locating ? "Locating..." : "Use my location"}
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
          <option value="">...or pick your area</option>
          {CITIES.map((c) => (
            <optgroup key={c} label={c}>
              {AREA_DATA[c].map((a) => <option key={a.area} value={`${c}::${a.area}`}>{a.area}</option>)}
            </optgroup>
          ))}
        </select>
        <select value={maxDistance} onChange={(e) => setMaxDistance(e.target.value)} disabled={!refLocation} className="select">
          <option value="any">Any distance</option>
          <option value="2">Within 2 km</option>
          <option value="5">Within 5 km</option>
          <option value="10">Within 10 km</option>
        </select>
        {refLocation && <button onClick={clearLocation} className="link-button">Clear</button>}
      </div>
      {!refLocation && <p className="muted small mb-4">Set your location to filter listings by distance.</p>}
    </div>
  );
}
