import { useState, useCallback } from "react";

export function useLocation(showToast) {
  const [refLocation, setRefLocation] = useState(null);
  const [locating, setLocating] = useState(false);

  const useMyLocation = useCallback(() => {
    if (!navigator.geolocation) { showToast?.("Location isn't available in this browser."); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { setRefLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude, label: "My location" }); setLocating(false); },
      () => { showToast?.("Couldn't get your location - pick your area instead."); setLocating(false); },
      { timeout: 8000 }
    );
  }, [showToast]);

  const setManualArea = useCallback((lat, lng, label, key) => {
    setRefLocation({ lat, lng, label, key });
  }, []);

  const clear = useCallback(() => setRefLocation(null), []);

  return { refLocation, locating, useMyLocation, setManualArea, clear };
}
