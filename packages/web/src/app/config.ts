/**
 * Application configuration for the composition root.
 *
 * Infrastructure endpoints (REST origin, realtime WebSocket URL) are resolved
 * here, at the edge of the app, and injected downward. Nothing below the
 * composition root reads globals like `location`; the networking and UI layers
 * receive fully-resolved values, keeping them framework- and
 * environment-independent (and unit-testable without a browser).
 */

/** Resolved endpoints the app talks to. */
export interface AppConfig {
  /** REST API origin (e.g. `https://api.gambit.example`); empty string = same origin. */
  readonly apiBaseUrl: string;
  /** Realtime gateway WebSocket URL (e.g. `wss://gambit.example/ws`). */
  readonly wsUrl: string;
}

/** The subset of `Location` the resolver reads (injectable for tests). */
export interface LocationLike {
  readonly protocol: string;
  readonly host: string;
  readonly origin: string;
}

/**
 * Derive default endpoints from the page location: same-origin REST and a
 * scheme-matched (`ws`/`wss`) realtime socket at `/ws`. These are defaults only;
 * a caller may build an {@link AppConfig} directly to point at another host.
 */
export function resolveConfig(loc?: LocationLike): AppConfig {
  const source: LocationLike | undefined =
    loc ?? (typeof location !== 'undefined' ? location : undefined);
  if (source === undefined) {
    return { apiBaseUrl: '', wsUrl: '' };
  }
  const wsScheme = source.protocol === 'https:' ? 'wss:' : 'ws:';
  return {
    apiBaseUrl: source.origin,
    wsUrl: `${wsScheme}//${source.host}/ws`,
  };
}
