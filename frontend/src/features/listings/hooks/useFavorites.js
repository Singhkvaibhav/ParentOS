import { useState, useEffect, useCallback, useRef } from "react";
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

  const isFavorited = useCallback((listingId) => favorites.some((f) => f.id === listingId), [favorites]);

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
