/**
 * The one UCI move-shape filter the feature services share.
 *
 * Three services filtered moves with three separately-written copies of this regex, and the copies
 * drifted: the Coach's omitted the Crazyhouse drop alternative, and because the Coach runs *before*
 * the services it composes, it refused legal drops as malformed input before any variant-aware rule
 * saw them (ADR-0129 §6b). A shared constant is the only version of that fix which cannot happen
 * again — a fourth caller gets the same filter by importing it rather than by remembering it.
 *
 * This is a cheap *filter*, not the legality check. It rejects obvious junk before a `Position` is
 * built and bounds what reaches the matcher. The authority is `Position.play`, which resolves the
 * move against generated legal moves and throws when there is no match.
 */

/**
 * Square-to-square with optional promotion, or a Crazyhouse-style piece drop.
 *
 * Exported as a string so each caller builds its own `RegExp` and no two share the mutable
 * `lastIndex` state a shared instance would carry.
 */
export const UCI_SHAPE_SOURCE = '^(?:[a-h][1-8][a-h][1-8][qrbn]?|[PNBRQ]@[a-h][1-8])$';

/**
 * @param move - a candidate move in UCI notation.
 * @returns whether it has the shape of a move. Says nothing about whether it is legal.
 */
export function isUciShape(move: string): boolean {
  return new RegExp(UCI_SHAPE_SOURCE).test(move);
}
