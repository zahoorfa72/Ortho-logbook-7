import { QueryClient } from "@tanstack/react-query";

/**
 * The app is local-first: queries and mutations use SQLite and must not be
 * paused by React Query's online/offline detector.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: "always",
      retry: false,
      staleTime: 30_000,
    },
    mutations: {
      networkMode: "always",
      retry: false,
    },
  },
});

/**
 * Immediately remove confirmed deletions from every cached list.
 * Screens can be frozen while off-screen, so invalidation alone may leave
 * deleted rows visible until the user navigates away or restarts the app.
 */
export function removeCachedRowsById(
  ids: readonly string[],
  invalidateKeys: readonly (readonly unknown[])[] = [],
): void {
  const deletedIds = new Set(ids.map((value) => String(value)).filter(Boolean));
  if (!deletedIds.size) return;

  for (const query of queryClient.getQueryCache().getAll()) {
    const current = query.state.data;
    if (!Array.isArray(current)) continue;

    let changed = false;
    const next = current.filter((row: unknown) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return true;
      const rowId = (row as { id?: unknown }).id;
      if (rowId == null || !deletedIds.has(String(rowId))) return true;
      changed = true;
      return false;
    });

    if (changed) queryClient.setQueryData(query.queryKey, next);
  }

  for (const queryKey of invalidateKeys) {
    void queryClient.invalidateQueries({ queryKey });
  }
}
