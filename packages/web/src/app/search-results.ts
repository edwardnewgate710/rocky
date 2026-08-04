/**
 * Pure search helpers and hit parsing logic for the Search UI.
 */
import type { SearchMode, SearchResult } from '../api/models.js';

export type SearchEntityType = 'game' | 'player' | 'tournament';

export interface ParsedSearchHit {
  readonly type: SearchEntityType | null;
  readonly id: string;
  readonly raw: string;
  readonly score: number;
}

export interface HydratedHit extends ParsedSearchHit {
  readonly label: string;
  readonly href?: string;
}

/** Split `game:<uuid>` into its type and id. Returns type `null` for an unrecognised prefix. */
export function parseSearchHit(result: SearchResult): ParsedSearchHit {
  const raw = result.id;
  const score = result.score;
  const colonIndex = raw.indexOf(':');

  if (colonIndex === -1) {
    return {
      type: null,
      id: raw,
      raw,
      score,
    };
  }

  const prefix = raw.slice(0, colonIndex);
  const id = raw.slice(colonIndex + 1);

  if (prefix === 'game' || prefix === 'player' || prefix === 'tournament') {
    return {
      type: prefix,
      id,
      raw,
      score,
    };
  }

  return {
    type: null,
    id,
    raw,
    score,
  };
}

export function parseSearchMode(raw: string | null): SearchMode {
  if (raw === 'keyword' || raw === 'semantic' || raw === 'hybrid') {
    return raw;
  }
  return 'keyword';
}

/**
 * Build the `/search` URL for a query and mode.
 *
 * Pure so the one place that binds the header form — `main.ts`, which binds document handlers once
 * because `bootstrap` re-runs on every navigation — carries no application logic. `keyword` is
 * omitted because it is the server's own default, keeping the shared URL as short as what the user
 * actually chose.
 */
export function buildSearchUrl(q: string, mode: SearchMode): string {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (mode !== 'keyword') params.set('mode', mode);
  return `/search?${params.toString()}`;
}
