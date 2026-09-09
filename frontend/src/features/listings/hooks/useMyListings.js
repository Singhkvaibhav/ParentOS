import { useState, useEffect, useCallback, useRef } from "react";
import { listingsService } from "../../../services/listings";
import { isAbortError } from "../../../services/api";

// `enabled` replaces the old `token` param - there's no client-visible
// token anymore (httpOnly cookie), so callers pass whether the user is
// logged in (e.g. `!!user` from useAuth) to gate fetching instead.
export function useMyListings(enabled) {
  const [listings, setListings] = useState([]);
  const [loading, setLoading] = useState(true);
  const controllerRef = useRef(null);

  const refresh = useCallback(async () => {
    if (!enabled) { setLoading(false); return; }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setLoading(true);
    try {
      const { listings } = await listingsService.mine(controller.signal);
      setListings(listings);
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

  const remove = useCallback(async (id) => {
    await listingsService.remove(id);
    await refresh();
  }, [refresh]);

  const reserve = useCallback(async (id) => { await listingsService.reserve(id); await refresh(); }, [refresh]);
  const markSold = useCallback(async (id) => { await listingsService.markSold(id); await refresh(); }, [refresh]);
  const relist = useCallback(async (id) => { await listingsService.relist(id); await refresh(); }, [refresh]);
  const update = useCallback(async (id, patch) => { await listingsService.update(id, patch); await refresh(); }, [refresh]);

  return { listings, loading, refresh, remove, reserve, markSold, relist, update };
}
