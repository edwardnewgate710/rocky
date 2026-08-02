import type { Chapter, Collaborator, Study, TreeNode } from './model';
import { roleRank } from './model';

/**
 * Compares two strings by UTF-16 code-unit order — what `<` does, and deliberately not
 * `localeCompare`, whose answer depends on the machine's locale and so cannot be reproduced by a
 * database ORDER BY.
 *
 * Code UNITS, not code points: the two differ above the BMP, where a surrogate pair sorts before
 * some single-unit characters. Every id compared here is an ASCII UUID, where the orders coincide
 * and also coincide with the byte order Postgres uses — which is the property that actually has to
 * hold.
 */
export function compareStringsCodePoint(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Order studies by `createdAt` DESC, tie-broken by `id` ASC in code-point order.
 */
export function compareStudies(a: Study, b: Study): number {
  const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
  if (timeDiff !== 0) return timeDiff;
  return compareStringsCodePoint(a.id, b.id);
}

/**
 * Order chapters by `orderIndex` ASC, tie-broken by `id` ASC in code-point order.
 */
export function compareChapters(a: Chapter, b: Chapter): number {
  const orderDiff = a.orderIndex - b.orderIndex;
  if (orderDiff !== 0) return orderDiff;
  return compareStringsCodePoint(a.id, b.id);
}

/**
 * Order collaborators by `role` rank DESC (owner > contributor > viewer), tie-broken by `playerId` ASC in code-point order.
 */
export function compareCollaborators(a: Collaborator, b: Collaborator): number {
  const rankDiff = roleRank(b.role) - roleRank(a.role);
  if (rankDiff !== 0) return rankDiff;
  return compareStringsCodePoint(a.playerId, b.playerId);
}

/**
 * Order sibling tree nodes by `orderIndex` ASC, tie-broken by `id` ASC in code-point order.
 */
export function compareTreeNodes(a: TreeNode, b: TreeNode): number {
  const orderDiff = a.orderIndex - b.orderIndex;
  if (orderDiff !== 0) return orderDiff;
  return compareStringsCodePoint(a.id, b.id);
}
