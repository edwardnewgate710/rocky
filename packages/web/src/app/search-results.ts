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

/**
 * A row, ready to render.
 *
 * Named for what it is rather than how it was built: nothing hydrates any more. The server sends
 * the title and subtitle on the hit, so this is a pure mapping from one response — no per-result
 * fetches, and no partial row when one of them fails.
 */
export interface SearchRow extends ParsedSearchHit {
  readonly label: string;
  readonly subtitle?: string;
  readonly href?: string;
}

/** Shorten a bare id for the fallback label. */
function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/**
 * Map one hit to a row.
 *
 * `display` is optional in the contract — a document indexed before the field existed still
 * matches — so a hit without it degrades to a linkless row labelled by its id rather than being
 * dropped. That is the same posture the old hydration took when a per-result fetch failed, minus
 * the fetch.
 */
export function toSearchRow(result: SearchResult): SearchRow {
  const parsed = parseSearchHit(result);
  const display = result.display;

  if (!display) {
    return { ...parsed, label: shortId(parsed.id) };
  }

  const href =
    display.type === 'tournament'
      ? `/tournaments/${encodeURIComponent(parsed.id)}`
      : display.type === 'game'
        ? `/game/${encodeURIComponent(parsed.id)}`
        : // A profile is addressed by handle, and for a player document the title *is* the handle.
          `/profile/${encodeURIComponent(display.title)}`;

  return {
    ...parsed,
    label: display.title,
    ...(display.subtitle !== undefined ? { subtitle: display.subtitle } : {}),
    href,
  };
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
