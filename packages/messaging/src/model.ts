import { MessagingRuleError } from './errors';

export type PlayerId = string;
export type ConversationId = string;
export type MessageId = string;

/** Maximum length for a single direct message body in characters. */
export const MAX_MESSAGE_LENGTH = 2000;

export interface Conversation {
  readonly id: ConversationId;
  readonly participantA: PlayerId;
  readonly participantB: PlayerId;
  readonly createdAt: Date;
  readonly lastMessageAt: Date;
}

export interface Message {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  readonly senderId: PlayerId;
  readonly body: string;
  readonly sentAt: Date;
  readonly editedAt?: Date;
  readonly deletedAt?: Date;
}

export interface ConversationReadState {
  readonly conversationId: ConversationId;
  readonly participantId: PlayerId;
  readonly lastReadAt: Date;
}

export interface ConversationSummary {
  readonly conversation: Conversation;
  readonly unreadCount: number;
  readonly lastMessage: Message | null;
}

/**
 * Normalizes two player IDs into a canonical ascending tuple using code-point order.
 * `participantA` is always strictly less than `participantB`.
 */
export function normalizePair(a: PlayerId, b: PlayerId): [PlayerId, PlayerId] {
  if (a < b) {
    return [a, b];
  }
  return [b, a];
}

export function assertDistinctParticipants(a: PlayerId, b: PlayerId): void {
  if (a === b) {
    throw new MessagingRuleError(
      'self_conversation',
      `Player '${a}' cannot have a conversation or send a message to themselves`
    );
  }
}
