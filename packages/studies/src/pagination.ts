/** Options for paginating a studies query. */
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
 * repository and Postgres adapters cannot drift apart on what a negative, fractional or
 * out-of-range limit/offset means.
 *
 * `NaN` is handled explicitly rather than left to `Math.max`, which propagates it: a `NaN` offset
 * makes `slice` return nothing while `total` still reports the real count, so a caller sees "47
 * results" above an empty list with no error anywhere. `NaN` is what `Number(queryParam)` yields
 * for unparseable input, so it is the shape malformed pagination actually arrives in.
 *
 * `Infinity` needs no case *here* — `slice` absorbs it, an infinite limit means "all remaining"
 * and an infinite offset means "past the end". That reasoning does not survive the trip to SQL:
 * `pg` serializes it as the string `"Infinity"` and Postgres rejects it as a malformed bigint.
 * The Postgres adapter handles it explicitly for that reason.
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
  if (Number.isNaN(limit)) {
    return 0;
  }
  return Math.max(0, Math.trunc(limit));
}
