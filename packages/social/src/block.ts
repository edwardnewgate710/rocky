import { compareRecentThenId } from './ordering';
import type { PlayerId } from './relation';

export interface BlockEdge {
  readonly blockerId: PlayerId;
  readonly blockedId: PlayerId;
  readonly blockedAt: Date;
}

/**
 * Returns true if either player has blocked the other.
 * A block is recorded one-way (so it can be undone by the right person) but takes effect both ways:
 * neither party may follow or friend the other.
 */
export function isBlockedBetween(
  a: PlayerId,
  b: PlayerId,
  blocks: readonly BlockEdge[]
): boolean {
  if (a === b) {
    return false;
  }
  return blocks.some(
    (edge) =>
      (edge.blockerId === a && edge.blockedId === b) ||
      (edge.blockerId === b && edge.blockedId === a)
  );
}

/**
 * Returns blocks initiated by playerId, newest first by blockedAt + blockedId ASC tie-break.
 */
export function blocksBy(
  playerId: PlayerId,
  blocks: readonly BlockEdge[]
): readonly BlockEdge[] {
  return blocks
    .filter((edge) => edge.blockerId === playerId)
    .sort((a, b) => compareRecentThenId(a.blockedAt, a.blockedId, b.blockedAt, b.blockedId));
}
