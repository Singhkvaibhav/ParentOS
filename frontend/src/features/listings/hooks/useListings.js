import { useState, useEffect, useCallback, useRef } from "react";
import { listingsService } from "../../../services/listings";
import { isAbortError } from "../../../services/api";

const PAGE_SIZE = 20;

// (P1 #8) The API has returned total/hasMore for several rounds, but the
// UI ignored it and only ever showed the first page - so anything past the
// 20th listing was simply unreachable by browsing.
//
// "Load more" appends rather than replacing, because a marketplace is
// browsed by scanning: paging that swaps the grid out loses the user's
// place and their scroll position.
export function useListings(filters, pageSize = PAGE_SIZE) {
  const [listings, setListings] = useState([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const controllerRef = useRef(null);

  const refresh = useCallback(async () => {
    // Cancel any still-in-flight request from a previous call (e.g. the
    // user changed filters again before the last fetch resolved) rather
    // than letting stale results race with fresh ones.
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const data = await listingsService.list({ ...filters, limit: pageSize, offset: 0 }, controller.signal);
      setListings(data.listings);
      setTotal(data.total ?? data.listings.length);
      setHasMore(!!data.hasMore);
    } catch (e) {
      if (!isAbortError(e)) setError(e.message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [filters, pageSize]);

  // Changing filters resets to page one - continuing from an old offset
  // against a different result set would show an arbitrary slice.
  useEffect(() => {
    refresh();
    return () => controllerRef.current?.abort();
  }, [refresh]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const data = await listingsService.list({ ...filters, limit: pageSize, offset: listings.length });
      // Deduplicate on id: a listing sold or created between pages can
      // otherwise shift the offset and produce a repeat.
      setListings((prev) => {
        const seen = new Set(prev.map((l) => l.id));
        return [...prev, ...data.listings.filter((l) => !seen.has(l.id))];
      });
      setTotal(data.total ?? 0);
      setHasMore(!!data.hasMore);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  }, [filters, pageSize, listings.length, hasMore, loadingMore]);

  return { listings, total, hasMore, loading, loadingMore, error, refresh, loadMore };
}
