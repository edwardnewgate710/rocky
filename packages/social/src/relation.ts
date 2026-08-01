import { SocialRuleError } from './errors';

export type PlayerId = string;

/**
 * Asserts that two player IDs are distinct.
 * Throws SocialRuleError('self_relation') when a === b. Every public mutation runs this first.
 */
export function assertDistinct(a: PlayerId, b: PlayerId): void {
  if (a === b) {
    throw new SocialRuleError('self_relation', 'Cannot form or modify a social relation with oneself');
  }
}

/**
 * Normalizes a pair of player IDs into an ascending tuple [min, max].
 * Symmetric relations (friendship, "is either of them blocking the other") are keyed on this
 * so one logical fact is never stored or checked twice, in either order.
 */
export function normalizePair(a: PlayerId, b: PlayerId): readonly [PlayerId, PlayerId] {
  return a < b ? [a, b] : [b, a];
}
