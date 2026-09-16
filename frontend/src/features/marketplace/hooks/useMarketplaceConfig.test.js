import { describe, test, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useMarketplaceConfig } from "./useMarketplaceConfig";
import { metaService } from "../../../services/meta";
import { CATEGORY_METADATA } from "../../../constants";

vi.mock("../../../services/meta", () => ({
  metaService: { config: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useMarketplaceConfig", () => {
  test("before the request settles: not loaded, categories use the presentation-only fallback", async () => {
    // A controlled, DEFERRED promise - not left eternally pending (that
    // hung this whole file once already) and not resolved immediately
    // either (which would settle before this test's own assertions run,
    // testing the wrong state). Resolved and awaited at the end so its
    // effects are flushed inside act() before the test - and the file -
    // moves on.
    let resolveConfig;
    metaService.config.mockReturnValue(new Promise((resolve) => { resolveConfig = resolve; }));
    const { result } = renderHook(() => useMarketplaceConfig());

    expect(result.current.loaded).toBe(false);
    expect(result.current.failed).toBe(false);
    expect(result.current.categories.map((c) => c.id)).toEqual(Object.keys(CATEGORY_METADATA));
    expect(result.current.conditions).toEqual([]);
    await act(async () => { resolveConfig({}); });
    expect(result.current.limits).toBe(null);
  });

  test("on success: reflects the server's config exactly, decorated with local presentation", async () => {
    metaService.config.mockResolvedValue({
      categories: ["clothes", "toys"],
      conditions: ["New with tags", "Good"],
      subcategories: { clothes: ["baby", "girls"] },
      deliveryFeeCents: 500,
      maxPriceCents: 10_000_000,
      limits: { titleLength: 140 },
    });

    const { result } = renderHook(() => useMarketplaceConfig());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    expect(result.current.failed).toBe(false);
    expect(result.current.categories).toEqual([
      { id: "clothes", ...CATEGORY_METADATA.clothes },
      { id: "toys", ...CATEGORY_METADATA.toys },
    ]);
    expect(result.current.conditions).toEqual(["New with tags", "Good"]);
    expect(result.current.subcategoriesByCategory).toEqual({ clothes: ["baby", "girls"] });
    expect(result.current.deliveryFeeCents).toBe(500);
    expect(result.current.maxPriceCents).toBe(10_000_000);
    expect(result.current.limits).toEqual({ titleLength: 140 });
  });

  test("a category id the frontend has no metadata for still renders, with a derived label", async () => {
    metaService.config.mockResolvedValue({ categories: ["outdoor-gear"] });
    const { result } = renderHook(() => useMarketplaceConfig());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    // lucide-react icons are forwardRef objects, not plain functions -
    // expect.any(Function) doesn't match them, so this only pins down the
    // fields that matter for this test (id/label); the icon just needs to
    // be present, not a specific type.
    expect(result.current.categories).toEqual([
      { id: "outdoor-gear", label: "Outdoor gear", icon: expect.anything() },
    ]);
  });

  test("on failure: loaded becomes true, failed is set, and categories fall back rather than disappearing", async () => {
    metaService.config.mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() => useMarketplaceConfig());

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.failed).toBe(true);
    expect(result.current.categories.map((c) => c.id)).toEqual(Object.keys(CATEGORY_METADATA));
    // Write-path fields deliberately do NOT fall back (see the hook's own
    // comment: guessing here would let the Sell form submit a value the
    // server was never actually confirmed to accept).
    expect(result.current.conditions).toEqual([]);
    expect(result.current.limits).toBe(null);
  });

  test("categories keeps the same array reference across a re-render when the ids haven't changed", async () => {
    metaService.config.mockResolvedValue({ categories: ["clothes"] });
    const { result, rerender } = renderHook(() => useMarketplaceConfig());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    const first = result.current.categories;
    rerender();
    expect(result.current.categories).toBe(first);
  });

  test("unmounting before the request resolves does not update state on the unmounted hook", async () => {
    let resolveConfig;
    metaService.config.mockReturnValue(new Promise((resolve) => { resolveConfig = resolve; }));

    const { result, unmount } = renderHook(() => useMarketplaceConfig());
    unmount();
    // act() here isn't guarding a real state update - it's confirming
    // there ISN'T one: the hook's own `cancelled` guard should skip both
    // setRaw and setLoaded post-unmount, so nothing throws and there's
    // nothing to assert on `result.current` beyond "no crash".
    await act(async () => {
      resolveConfig({ categories: ["clothes"] });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.loaded).toBe(false);
  });
});
