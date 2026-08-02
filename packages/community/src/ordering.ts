import type { ForumPost, ForumThread, Membership, Team } from './model';
import { roleRank } from './model';

/**
 * Code-point string comparison rather than `localeCompare`.
 */
export function compareIds(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/**
 * Thread ordering: `pinned` DESC (true before false), then `lastPostAt` DESC,
 * tie-broken by thread `id` ASC in code-point order.
 */
export function compareThreads(a: ForumThread, b: ForumThread): number {
  if (a.pinned !== b.pinned) {
    return a.pinned ? -1 : 1;
  }
  const byLastPost = b.lastPostAt.getTime() - a.lastPostAt.getTime();
  if (byLastPost !== 0) {
    return byLastPost;
  }
  return compareIds(a.id, b.id);
}

/**
 * Post ordering: oldest-first by `createdAt` ASC,
 * tie-broken by post `id` ASC in code-point order.
 */
export function comparePosts(a: ForumPost, b: ForumPost): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  if (byTime !== 0) {
    return byTime;
  }
  return compareIds(a.id, b.id);
}

/**
 * Member ordering: `role` authority DESC (`owner` > `admin` > `member`),
 * then `joinedAt` ASC, tie-broken by player `id` ASC in code-point order.
 */
export function compareMembers(a: Membership, b: Membership): number {
  const rankDiff = roleRank(b.role) - roleRank(a.role);
  if (rankDiff !== 0) {
    return rankDiff;
  }
  const byJoined = a.joinedAt.getTime() - b.joinedAt.getTime();
  if (byJoined !== 0) {
    return byJoined;
  }
  return compareIds(a.playerId, b.playerId);
}

/**
 * Team listing ordering: `createdAt` DESC, tie-broken by team `id` ASC in code-point order.
 */
export function compareTeams(a: Team, b: Team): number {
  const byTime = b.createdAt.getTime() - a.createdAt.getTime();
  if (byTime !== 0) {
    return byTime;
  }
  return compareIds(a.id, b.id);
}
