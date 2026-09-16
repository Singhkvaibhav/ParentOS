import { describe, test, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useFavorites } from "./useFavorites";
import { favoritesService } from "../../../services/favorites";

vi.mock("../../../services/favorites", () => ({
  favoritesService: {
    list: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useFavorites", () => {
  test("disabled (no user): never calls the API, loading settles to false immediately", async () => {
    const { result } = renderHook(() => useFavorites(false));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(favoritesService.list).not.toHaveBeenCalled();
    expect(result.current.favorites).toEqual([]);
  });

  test("enabled: loads favorites and isFavorited reflects them", async () => {
    favoritesService.list.mockResolvedValue({ favorites: [{ id: 1 }, { id: 3 }] });

    const { result } = renderHook(() => useFavorites(true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.favorites).toEqual([{ id: 1 }, { id: 3 }]);
    expect(result.current.isFavorited(1)).toBe(true);
    expect(result.current.isFavorited(2)).toBe(false);
    expect(result.current.isFavorited(3)).toBe(true);
  });

  test("toggle calls add() for a listing that isn't favorited yet, then refreshes", async () => {
    favoritesService.list
      .mockResolvedValueOnce({ favorites: [] })
      .mockResolvedValueOnce({ favorites: [{ id: 5 }] });
    favoritesService.add.mockResolvedValue({});

    const { result } = renderHook(() => useFavorites(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isFavorited(5)).toBe(false);

    await act(() => result.current.toggle(5));

    expect(favoritesService.add).toHaveBeenCalledWith(5);
    expect(favoritesService.remove).not.toHaveBeenCalled();
    expect(result.current.isFavorited(5)).toBe(true);
  });

  test("toggle calls remove() for a listing that's already favorited", async () => {
    favoritesService.list
      .mockResolvedValueOnce({ favorites: [{ id: 7 }] })
      .mockResolvedValueOnce({ favorites: [] });
    favoritesService.remove.mockResolvedValue({});

    const { result } = renderHook(() => useFavorites(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isFavorited(7)).toBe(true);

    await act(() => result.current.toggle(7));

    expect(favoritesService.remove).toHaveBeenCalledWith(7);
    expect(favoritesService.add).not.toHaveBeenCalled();
    expect(result.current.isFavorited(7)).toBe(false);
  });

  test("isFavorited is a stable O(1) lookup, not re-created unless favorites actually change", async () => {
    favoritesService.list.mockResolvedValue({ favorites: [{ id: 1 }] });
    const { result, rerender } = renderHook(() => useFavorites(true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const firstIsFavorited = result.current.isFavorited;
    rerender();
    expect(result.current.isFavorited).toBe(firstIsFavorited);
  });
});
