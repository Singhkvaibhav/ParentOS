// Mirrors frontend/src/constants.js AREA_DATA. Kept duplicated deliberately for
// now so frontend and backend can be deployed independently; consider moving
// this into a shared package once the two start drifting.
const AREA_DATA = {
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

function findArea(city, area) {
  const list = AREA_DATA[city] || [];
  return list.find((a) => a.area === area) || list[0] || null;
}

function haversineKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

module.exports = { AREA_DATA, findArea, haversineKm };
