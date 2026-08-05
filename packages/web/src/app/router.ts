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
 * - `/tournaments` → tournaments list
 * - `/tournaments/{id}` → tournament detail
 * - `/search` → search
 */

export type Route =
  | { readonly name: 'lobby' }
  | { readonly name: 'game'; readonly gameId: string }
  | { readonly name: 'profile'; readonly handle: string | null }
  | { readonly name: 'tournaments' }
  | { readonly name: 'tournament'; readonly id: string }
  | { readonly name: 'search' }
  | { readonly name: 'messages' }
  | { readonly name: 'conversation'; readonly id: string }
  | { readonly name: 'teams' }
  | { readonly name: 'team'; readonly slug: string }
  | { readonly name: 'forum'; readonly slug: string }
  | { readonly name: 'thread'; readonly slug: string; readonly threadId: string }
  | { readonly name: 'courses' }
  | { readonly name: 'course'; readonly slug: string }
  | { readonly name: 'lesson'; readonly id: string }
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
  if (segments[0] === 'tournaments') {
    if (segments.length === 1) return { name: 'tournaments' };
    return { name: 'tournament', id: decodeSegment(segments[1]!) };
  }
  if (segments[0] === 'search') {
    return { name: 'search' };
  }
  if (segments[0] === 'messages') {
    if (segments.length === 1) return { name: 'messages' };
    return { name: 'conversation', id: decodeSegment(segments[1]!) };
  }
  if (segments[0] === 'courses') {
    if (segments.length === 1) return { name: 'courses' };
    return { name: 'course', slug: decodeSegment(segments[1]!) };
  }
  if (segments[0] === 'lessons') {
    if (segments.length >= 2) {
      return { name: 'lesson', id: decodeSegment(segments[1]!) };
    }
    return { name: 'not-found' };
  }
  if (segments[0] === 'teams') {
    if (segments.length === 1) return { name: 'teams' };
    const slug = decodeSegment(segments[1]!);
    if (segments.length === 2) return { name: 'team', slug };
    // The forum is nested under its team, mirroring the API. Anything else under a team slug is
    // not a route we serve — say so rather than falling through to the team page.
    if (segments[2] === 'forum') {
      if (segments.length === 3) return { name: 'forum', slug };
      if (segments.length === 4) return { name: 'thread', slug, threadId: decodeSegment(segments[3]!) };
    }
    return { name: 'not-found' };
  }
  return { name: 'not-found' };
}

/**
 * Decode a single path segment, tolerating malformed input.
 *
 * The link that produces this URL percent-encodes the id, and the API client encodes it again on
 * the way out, so a segment left encoded here would be sent double-encoded and resolve to nothing.
 * Today's ids are UUIDs, which survive `encodeURIComponent` untouched — this keeps the round trip
 * honest for anything that does not. `decodeURIComponent` throws on a malformed escape (`%zz`),
 * which a hand-typed URL can easily contain, and a thrown router is a blank page; the raw segment
 * is the better answer because it simply fails to match a tournament.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
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
    case 'tournaments':
      return '/tournaments';
    case 'tournament':
      return `/tournaments/${route.id}`;
    case 'search':
      return '/search';
    case 'messages':
      return '/messages';
    case 'conversation':
      return `/messages/${route.id}`;
    case 'teams':
      return '/teams';
    case 'team':
      return `/teams/${route.slug}`;
    case 'forum':
      return `/teams/${route.slug}/forum`;
    case 'thread':
      return `/teams/${route.slug}/forum/${route.threadId}`;
    case 'courses':
      return '/courses';
    case 'course':
      return `/courses/${route.slug}`;
    case 'lesson':
      return `/lessons/${route.id}`;
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
