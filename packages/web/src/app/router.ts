/**
 * Client-side router — a pure, DOM-free path matcher for the Gambit SPA.
 *
 * Parses the URL pathname into a typed route, and provides a `navigate`
 * function that updates the URL via `history.pushState` (injectable for
 * tests). The router does not touch the DOM; the bootstrap layer reads the
 * route and mounts the appropriate view.
 *
 * Supported routes:
 * - `/` → lobby
 * - `/game/{id}` → game view
 * - `/profile` → profile (future)
 * - `/profile/{handle}` → profile for a specific user (future)
 */

export type Route =
  | { readonly name: 'lobby' }
  | { readonly name: 'game'; readonly gameId: string }
  | { readonly name: 'profile'; readonly handle: string | null }
  | { readonly name: 'not-found' };

/** Parse a URL pathname into a typed route. */
export function parseRoute(pathname: string): Route {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return { name: 'lobby' };
  if (segments[0] === 'game' && segments.length >= 2) {
    return { name: 'game', gameId: segments[1]! };
  }
  if (segments[0] === 'profile') {
    return { name: 'profile', handle: segments[1] ?? null };
  }
  return { name: 'not-found' };
}

/** Serialize a route back to a URL pathname. */
export function routeToPath(route: Route): string {
  switch (route.name) {
    case 'lobby':
      return '/';
    case 'game':
      return `/game/${route.gameId}`;
    case 'profile':
      return route.handle !== null ? `/profile/${route.handle}` : '/profile';
    case 'not-found':
      return '/not-found';
  }
}

/** Injectable history-like seam (for tests). */
export interface HistoryLike {
  pushState(data: unknown, title: string, url: string): void;
}

/** Navigate to a route by updating the URL. */
export function navigate(route: Route, hist?: HistoryLike): void {
  const path = routeToPath(route);
  const h = hist ?? (typeof globalThis !== 'undefined' && typeof globalThis.history !== 'undefined'
    ? (globalThis.history as unknown as HistoryLike)
    : undefined);
  h?.pushState(null, '', path);
}
