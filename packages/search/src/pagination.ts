import type { SearchResult } from './search';

/** Pagination/query options for a repository query. */
export interface SearchOptions {
  /** Max results to return (the page size). Omitted/undefined => all hits. Values < 0 clamp to 0. */
  readonly limit?: number;
  /** Number of leading hits to skip. Omitted/undefined => 0. Values < 0 clamp to 0. */
  readonly offset?: number;
}

/** A page of ranked results plus the total number of hits (before pagination). */
export interface SearchPage {
  /** Total hits matching the query across the whole index (independent of limit/offset). */
  readonly total: number;
  /** The requested page of ranked results (already sorted by the underlying matcher). */
  readonly results: readonly SearchResult[];
}

/**
 * Slices a fully ranked hit list into the requested page. The clamping contract lives here so the
 * keyword and semantic repositories cannot drift apart on what a negative or out-of-range
 * limit/offset means; Postgres adapters must reproduce these same semantics.
 */
export function paginate(allHits: readonly SearchResult[], options?: SearchOptions): SearchPage {
  const total = allHits.length;
  const start = Math.max(0, options?.offset ?? 0);
  const limit = options?.limit;
  const end = limit === undefined ? total : start + Math.max(0, limit);

  return { total, results: allHits.slice(start, end) };
}
