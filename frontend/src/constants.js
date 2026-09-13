import { Shirt, Tag, Puzzle, Package } from "lucide-react";

// PRESENTATION ONLY. The authoritative list of valid categories lives in
// backend/config.js and arrives via GET /api/meta/config - this maps an id
// the backend already vouched for onto how it should look.
//
// The split matters because the backend validates submissions against its
// own list. A hardcoded frontend list is not a convenience, it's a second
// source of truth that silently drifts: add a category on the server and
// the UI never shows it; remove one and the UI offers something every
// submission will reject.
//
// An id with no entry here still renders (see categoryMeta) - a new
// backend category degrades to a default icon and a derived label rather
// than disappearing from the UI.
export const CATEGORY_METADATA = {
  clothes: { label: "Clothes", icon: Shirt },
  accessories: { label: "Accessories", icon: Tag },
  toys: { label: "Toys", icon: Puzzle },
};

const DEFAULT_CATEGORY_ICON = Package;

// Presentation for a category id, with a graceful default so an unknown
// id from the backend is still usable rather than crashing or vanishing.
export function categoryMeta(id) {
  return (
    CATEGORY_METADATA[id] || {
      label: String(id || "")
        .replace(/[-_]/g, " ")
        .replace(/^./, (c) => c.toUpperCase()),
      icon: DEFAULT_CATEGORY_ICON,
    }
  );
}

// Kept in sync with backend/areaData.js by hand for now.
export const AREA_DATA = {
  Helsinki: [
    { area: "Kamppi", pincode: "00100", lat: 60.1682, lng: 24.9316 },
    { area: "Kallio", pincode: "00530", lat: 60.1841, lng: 24.9500 },
    { area: "Toolo", pincode: "00260", lat: 60.1756, lng: 24.9130 },
    { area: "Herttoniemi", pincode: "00810", lat: 60.1889, lng: 25.0089 },
    { area: "Malmi", pincode: "00700", lat: 60.2477, lng: 25.0086 },
    { area: "Itakeskus", pincode: "00930", lat: 60.2136, lng: 25.0797 },
  ],
  Espoo: [
    { area: "Tapiola", pincode: "02100", lat: 60.1756, lng: 24.8047 },
    { area: "Leppavaara", pincode: "02600", lat: 60.2189, lng: 24.8133 },
    { area: "Matinkyla", pincode: "02230", lat: 60.1602, lng: 24.7391 },
    { area: "Espoon keskus", pincode: "02770", lat: 60.2047, lng: 24.6559 },
  ],
  Vantaa: [
    { area: "Tikkurila", pincode: "01300", lat: 60.2934, lng: 25.0378 },
    { area: "Myyrmaki", pincode: "01600", lat: 60.2626, lng: 24.8524 },
    { area: "Korso", pincode: "01450", lat: 60.3563, lng: 25.0997 },
  ],
};

export const CITIES = Object.keys(AREA_DATA);

export function areaEntry(city, area) {
  return (AREA_DATA[city] || []).find((a) => a.area === area) || AREA_DATA[city]?.[0];
}

// Returns an i18n key suffix (see locales' "sizeLabel" namespace) rather
// than display text, so callers translate it: t(`sizeLabel.${sizeLabelFor(category)}`).
export function sizeLabelFor(category) {
  if (category === "toys") return "age";
  if (category === "accessories") return "fits";
  return "size";
}
