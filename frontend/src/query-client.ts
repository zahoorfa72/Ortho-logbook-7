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
