import type { PlayerId } from './relation';

/**
 * The one definition of "player id ascending" in this package.
 *
 * Deliberately a code-point comparison rather than `localeCompare`: locale-aware collation orders
 * `'a'` before `'B'`, code-point order does not, and the two disagree on any id set that mixes
 * case or non-ASCII. That difference is not cosmetic — this comparator is the pagination tie-break
 * (see `compareRecentThenId`), so a Postgres adapter that ordered differently would let a row show
 * up on two pages or on none. The SQL that reproduces this is `ORDER BY <id> COLLATE "C"`; ordering
 * by a default collation would silently drift from the in-memory adapter.
 *
 * `normalizePair` uses the same `<` semantics, so "ascending" means one thing package-wide.
 */
export function compareIds(a: PlayerId, b: PlayerId): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/**
 * The shared ordering contract for every list this package returns: newest first by timestamp,
 * then by counterpart id ascending.
 *
 * The tie-break is load-bearing. Timestamps collide routinely — a block tears down several
 * relations with a single `at`, and any batch import shares one clock reading — and a sort with no
 * total order leaves those rows in an arbitrary, unrepeatable sequence. Pagination on top of an
 * unrepeatable sequence drops and duplicates rows.
 */
export function compareRecentThenId(
  aAt: Date,
  aId: PlayerId,
  bAt: Date,
  bId: PlayerId
): number {
  const byRecency = bAt.getTime() - aAt.getTime();
  return byRecency !== 0 ? byRecency : compareIds(aId, bId);
}
