import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { favoritesService } from "../../../services/favorites";
import { isAbortError } from "../../../services/api";

// `enabled` replaces the old `token` param - see useMyListings.js.
export function useFavorites(enabled) {
  const [favorites, setFavorites] = useState([]);
  const [loading, setLoading] = useState(true);
  const controllerRef = useRef(null);

  const refresh = useCallback(async () => {
    if (!enabled) { setLoading(false); return; }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setLoading(true);
    try {
      const { favorites } = await favoritesService.list(controller.signal);
      setFavorites(favorites);
    } catch (e) {
      if (!isAbortError(e)) throw e;
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    refresh();
    return () => controllerRef.current?.abort();
  }, [refresh]);

  // A grid renders this per visible card, so a linear .some() scan here
  // was effectively O(listings x favorites) per render. Built once per
  // `favorites` change instead, so a lookup is O(1).
  const favoriteIds = useMemo(() => new Set(favorites.map((f) => f.id)), [favorites]);
  const isFavorited = useCallback((listingId) => favoriteIds.has(listingId), [favoriteIds]);

  const toggle = useCallback(async (listingId) => {
    if (isFavorited(listingId)) {
      await favoritesService.remove(listingId);
    } else {
      await favoritesService.add(listingId);
    }
    await refresh();
  }, [isFavorited, refresh]);

  return { favorites, loading, isFavorited, toggle };
}
