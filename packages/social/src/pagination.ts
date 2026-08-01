/** Options for paginating a social graph query. */
export interface PageOptions {
  /**
   * Max items to return (the page size). Omitted/undefined => all remaining items. Values < 0
   * clamp to 0, fractions truncate, and `NaN` clamps to 0 (see `paginate`).
   */
  readonly limit?: number;
  /**
   * Number of leading items to skip. Omitted/undefined => 0. Values < 0 clamp to 0, fractions
   * truncate, and `NaN` is treated as absent (see `paginate`).
   */
  readonly offset?: number;
}

/** A page of domain items plus the total number of items (before pagination). */
export interface Page<T> {
  /** Total items matching the query (independent of limit/offset). */
  readonly total: number;
  /** The requested page of items. */
  readonly items: readonly T[];
}

/**
 * Slices a list into the requested page. The clamping contract lives here so the in-memory
 * repository and future Postgres adapters cannot drift apart on what a negative, fractional or
 * out-of-range limit/offset means; Postgres adapters must reproduce these same semantics.
 *
 * `NaN` is handled explicitly rather than left to `Math.max`, which propagates it: a `NaN` offset
 * used to make `slice` return nothing while `total` still reported the real count, so a caller saw
 * "47 results" above an empty list and no error anywhere. `NaN` is what `Number(queryParam)` yields
 * for unparseable input, so this is the shape malformed pagination actually arrives in.
 *
 * `Infinity` needs no special case: an infinite limit correctly means "all remaining", and an
 * infinite offset correctly means "past the end".
 */
export function paginate<T>(all: readonly T[], options?: PageOptions): Page<T> {
  const total = all.length;
  const start = normalizeOffset(options?.offset);
  const limit = normalizeLimit(options?.limit);
  const end = limit === undefined ? total : start + limit;

  return { total, items: all.slice(start, end) };
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined || Number.isNaN(offset)) {
    return 0;
  }
  return Math.max(0, Math.trunc(offset));
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  // An unparseable page size means "give me nothing", not "give me everything" — the safer of the
  // two failures, and the one consistent with a negative limit.
  if (Number.isNaN(limit)) {
    return 0;
  }
  return Math.max(0, Math.trunc(limit));
}
