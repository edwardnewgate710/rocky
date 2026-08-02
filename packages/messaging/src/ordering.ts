import type { ConversationId, MessageId } from './model';

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
 * Thread ordering for messages in a conversation: oldest-first by sentAt (ASC),
 * tie-broken by message ID ascending in code-point order.
 */
export function compareOldestThenId(
  aSentAt: Date,
  aId: MessageId,
  bSentAt: Date,
  bId: MessageId
): number {
  const byTime = aSentAt.getTime() - bSentAt.getTime();
  return byTime !== 0 ? byTime : compareIds(aId, bId);
}

/**
 * Conversation list ordering: last activity descending (DESC),
 * tie-broken by conversation ID ascending in code-point order.
 */
export function compareRecentActivityThenId(
  aAt: Date,
  aId: ConversationId,
  bAt: Date,
  bId: ConversationId
): number {
  const byRecency = bAt.getTime() - aAt.getTime();
  return byRecency !== 0 ? byRecency : compareIds(aId, bId);
}
