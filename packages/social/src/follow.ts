import { compareRecentThenId } from './ordering';
import type { PlayerId } from './relation';

export interface FollowEdge {
  readonly followerId: PlayerId;
  readonly followeeId: PlayerId;
  readonly followedAt: Date;
}

/**
 * Builds a comparator applying the package ordering contract (newest first, counterpart id
 * ascending) to follow edges, where "counterpart" depends on which side of the edge the caller is
 * listing: the follower when listing followers, the followee when listing followees.
 *
 * Taking the accessor rather than four positional arguments means a caller cannot pair an edge
 * with the wrong side's id.
 */
export function byCounterpart(
  counterpartOf: (edge: FollowEdge) => PlayerId
): (a: FollowEdge, b: FollowEdge) => number {
  return (a, b) =>
    compareRecentThenId(a.followedAt, counterpartOf(a), b.followedAt, counterpartOf(b));
}

/** Returns true iff followerId follows followeeId. */
export function isFollowing(
  followerId: PlayerId,
  followeeId: PlayerId,
  edges: readonly FollowEdge[]
): boolean {
  return edges.some((e) => e.followerId === followerId && e.followeeId === followeeId);
}

/**
 * Returns followers of playerId, newest first by followedAt + followerId ASC.
 */
export function followersOf(
  playerId: PlayerId,
  edges: readonly FollowEdge[]
): readonly FollowEdge[] {
  return edges
    .filter((e) => e.followeeId === playerId)
    .sort(byCounterpart((e) => e.followerId));
}

/**
 * Returns players followed by playerId, newest first by followedAt + followeeId ASC.
 */
export function followingOf(
  playerId: PlayerId,
  edges: readonly FollowEdge[]
): readonly FollowEdge[] {
  return edges
    .filter((e) => e.followerId === playerId)
    .sort(byCounterpart((e) => e.followeeId));
}
