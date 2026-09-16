// Same tokens as the Uusiki design canvas (Main.dc.html / MobileApp.dc.html),
// translated to React Native StyleSheet values. Keep these in sync if the
// design canvas palette ever changes.
export const colors = {
  bg: '#f3f2f2',
  surface: '#eae9e9',
  text: '#201e1d',
  accent: '#ec3013',
  accentLight: '#fff2ef',
  accentDark: '#7c1405',
  neutral200: '#eae7e7',
  neutral300: '#d7d3d3',
  neutral700: '#605d5d',
  divider: 'rgba(32,30,29,0.4)',
};

// The design canvas uses 0-radius everywhere (deliberately sharp) — matched here.
export const radius = 0;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

export const fonts = {
  heading: 'Archivo_800ExtraBold',
  headingBold: 'Archivo_700Bold',
  body: 'Archivo_400Regular',
  bodyMedium: 'Archivo_600SemiBold',
};

// Mirrors backend/data/areaData.js, which is itself a deliberate duplicate
// of frontend/src/constants.js's AREA_DATA (same comment applies here: kept
// duplicated so this app can be deployed independently of the backend,
// rather than shared through a package). Listing creation resolves
// city/area against this exact list server-side, so this app must offer
// the same names or every submission fails with "Unknown city/area
// combination."
export const AREA_DATA: Record<string, string[]> = {
  Helsinki: ['Kamppi', 'Kallio', 'Toolo', 'Herttoniemi', 'Malmi', 'Itakeskus'],
  Espoo: ['Tapiola', 'Leppavaara', 'Matinkyla', 'Espoon keskus'],
  Vantaa: ['Tikkurila', 'Myyrmaki', 'Korso'],
};

export function categoryLabel(id: string) {
  return id.charAt(0).toUpperCase() + id.slice(1);
}
