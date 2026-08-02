import { MessagingRuleError } from './errors';
import type {
  Conversation,
  ConversationId,
  ConversationReadState,
  ConversationSummary,
  Message,
  MessageId,
  PlayerId,
} from './model';
import {
  assertDistinctParticipants,
  MAX_MESSAGE_LENGTH,
  normalizePair,
} from './model';
import { compareOldestThenId, compareRecentActivityThenId } from './ordering';
import type { Page, PageOptions } from './pagination';
import { paginate } from './pagination';

/**
 * Narrow port checking if a social block exists between two players.
 * Used by the domain to stay dependency-free from @chess-platform/social.
 */
export interface BlockChecker {
  isBlockedBetween(a: PlayerId, b: PlayerId): Promise<boolean>;
}

/**
 * Storage-agnostic port for direct 1:1 messaging.
 *
 * Every implementation owes all of these invariants:
 *
 * 1. A player cannot open a conversation with, or send a message to, themselves (`self_conversation`).
 * 2. Opening a conversation or sending a message is refused when a block exists in EITHER direction (`blocked`).
 * 3. Message bodies must be non-empty and non-whitespace after trimming, and must not exceed
 *    `MAX_MESSAGE_LENGTH`. The trimmed body is stored (`invalid_body`).
 * 4. Only the sender may edit or delete their own message. Editing sets `editedAt`; deleting is a
 *    tombstone (`deletedAt` set, body cleared to `""`). A deleted message cannot be edited, and a deleted message
 *    cannot be deleted twice (`invalid_transition`).
 * 5. Marking a conversation read is per-participant and monotonic: `lastReadAt` never moves backwards.
 * 6. `not_found` and `not_authorized` are not interchangeable, and which one applies is a security decision:
 *    - Anything the actor is not a participant in — a conversation, or a message inside one — reads as
 *      `not_found`. `not_authorized` there would confirm the id is real, and ids are UUIDv7, which
 *      embed a timestamp and are therefore guessable near a known one.
 *    - `not_authorized` is reserved for the case where the actor *is* a participant but still may not
 *      act: editing or deleting the other participant's message in their own thread. They can already
 *      list that message, so the 403 discloses nothing.
 * 7. Unread count for a participant counts non-tombstoned messages from the OTHER participant with `sentAt > lastReadAt`.
 *    A participant's own messages never count as unread.
 * 8. Messages in a conversation are ordered oldest-first by `sentAt` ASC, tie-broken by message `id` ASC in code-point order.
 *    Conversation lists are ordered by last-activity `lastMessageAt` DESC, tie-broken by conversation `id` ASC.
 *    `NaN` and `Infinity` pagination inputs are handled safely.
 */
export interface MessagingRepository {
  getOrCreateConversation(
    id: ConversationId,
    participantA: PlayerId,
    participantB: PlayerId,
    at: Date
  ): Promise<Conversation>;

  getConversation(
    conversationId: ConversationId,
    actorId: PlayerId
  ): Promise<Conversation>;

  listConversations(
    participantId: PlayerId,
    options?: PageOptions
  ): Promise<Page<ConversationSummary>>;

  sendMessage(
    id: MessageId,
    conversationId: ConversationId,
    senderId: PlayerId,
    body: string,
    at: Date
  ): Promise<Message>;

  editMessage(
    messageId: MessageId,
    actorId: PlayerId,
    body: string,
    at: Date
  ): Promise<Message>;

  deleteMessage(
    messageId: MessageId,
    actorId: PlayerId,
    at: Date
  ): Promise<Message>;

  listMessages(
    conversationId: ConversationId,
    actorId: PlayerId,
    options?: PageOptions
  ): Promise<Page<Message>>;

  markAsRead(
    conversationId: ConversationId,
    participantId: PlayerId,
    at: Date
  ): Promise<ConversationReadState>;

  getUnreadCount(
    participantId: PlayerId
  ): Promise<number>;
}

export class InMemoryMessagingRepository implements MessagingRepository {
  private readonly conversations = new Map<ConversationId, Conversation>();
  private readonly messages = new Map<MessageId, Message>();
  private readonly reads = new Map<string, ConversationReadState>();

  constructor(
    private readonly blockChecker: BlockChecker = {
      isBlockedBetween: async () => false,
    }
  ) {}

  async clear(): Promise<void> {
    this.conversations.clear();
    this.messages.clear();
    this.reads.clear();
  }

  private readKey(conversationId: ConversationId, participantId: PlayerId): string {
    return `${conversationId}:${participantId}`;
  }

  /**
   * Resolves a message the actor is allowed to *see*, which is a weaker question than whether they
   * may change it. Both are needed, and collapsing them leaks: answering `not_authorized` for a
   * message in someone else's thread confirms the id exists, and message ids are UUIDv7 — they
   * embed a timestamp, so an attacker guessing near a known id is not guessing blindly.
   * A message inside the actor's own conversation is different: they can already list it, so
   * `not_authorized` there tells them nothing they did not have.
   */
  private async findVisibleMessage(messageId: MessageId, actorId: PlayerId): Promise<Message> {
    const msg = this.messages.get(messageId);
    if (!msg) {
      throw new MessagingRuleError('not_found', `Message '${messageId}' not found`);
    }
    await this.getConversation(msg.conversationId, actorId);
    return msg;
  }

  async getOrCreateConversation(
    id: ConversationId,
    participantA: PlayerId,
    participantB: PlayerId,
    at: Date
  ): Promise<Conversation> {
    assertDistinctParticipants(participantA, participantB);

    if (await this.blockChecker.isBlockedBetween(participantA, participantB)) {
      throw new MessagingRuleError(
        'blocked',
        `Cannot start conversation because a block exists between ${participantA} and ${participantB}`
      );
    }

    const [pA, pB] = normalizePair(participantA, participantB);

    for (const conv of this.conversations.values()) {
      if (conv.participantA === pA && conv.participantB === pB) {
        return conv;
      }
    }

    const newConv: Conversation = {
      id,
      participantA: pA,
      participantB: pB,
      createdAt: at,
      lastMessageAt: at,
    };
    this.conversations.set(id, newConv);
    return newConv;
  }

  async getConversation(
    conversationId: ConversationId,
    actorId: PlayerId
  ): Promise<Conversation> {
    const conv = this.conversations.get(conversationId);
    if (!conv || (conv.participantA !== actorId && conv.participantB !== actorId)) {
      throw new MessagingRuleError('not_found', `Conversation '${conversationId}' not found`);
    }
    return conv;
  }

  async listConversations(
    participantId: PlayerId,
    options?: PageOptions
  ): Promise<Page<ConversationSummary>> {
    const matchingConvs = Array.from(this.conversations.values()).filter(
      (c) => c.participantA === participantId || c.participantB === participantId
    );

    const summaries: ConversationSummary[] = matchingConvs.map((conv) => {
      const readState = this.reads.get(this.readKey(conv.id, participantId));
      const lastReadAt = readState?.lastReadAt;

      const convMsgs = Array.from(this.messages.values())
        .filter((m) => m.conversationId === conv.id)
        .sort((a, b) => compareOldestThenId(a.sentAt, a.id, b.sentAt, b.id));

      const unreadCount = convMsgs.filter(
        (m) =>
          m.senderId !== participantId &&
          m.deletedAt === undefined &&
          (lastReadAt === undefined || m.sentAt > lastReadAt)
      ).length;

      const lastMessage = convMsgs.length > 0 ? convMsgs[convMsgs.length - 1] : null;

      return {
        conversation: conv,
        unreadCount,
        lastMessage,
      };
    });

    summaries.sort((a, b) =>
      compareRecentActivityThenId(
        a.conversation.lastMessageAt,
        a.conversation.id,
        b.conversation.lastMessageAt,
        b.conversation.id
      )
    );

    return paginate(summaries, options);
  }

  async sendMessage(
    id: MessageId,
    conversationId: ConversationId,
    senderId: PlayerId,
    body: string,
    at: Date
  ): Promise<Message> {
    const trimmed = body.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_MESSAGE_LENGTH) {
      throw new MessagingRuleError(
        'invalid_body',
        `Message body must be non-empty and at most ${MAX_MESSAGE_LENGTH} characters`
      );
    }

    const conv = this.conversations.get(conversationId);
    if (!conv || (conv.participantA !== senderId && conv.participantB !== senderId)) {
      throw new MessagingRuleError('not_found', `Conversation '${conversationId}' not found`);
    }

    const otherId = conv.participantA === senderId ? conv.participantB : conv.participantA;
    if (await this.blockChecker.isBlockedBetween(senderId, otherId)) {
      throw new MessagingRuleError(
        'blocked',
        `Cannot send message because a block exists between ${senderId} and ${otherId}`
      );
    }

    const msg: Message = {
      id,
      conversationId,
      senderId,
      body: trimmed,
      sentAt: at,
    };

    this.messages.set(id, msg);

    const updatedConv: Conversation = {
      ...conv,
      lastMessageAt: at,
    };
    this.conversations.set(conversationId, updatedConv);

    return msg;
  }

  async editMessage(
    messageId: MessageId,
    actorId: PlayerId,
    body: string,
    at: Date
  ): Promise<Message> {
    const msg = await this.findVisibleMessage(messageId, actorId);

    if (msg.senderId !== actorId) {
      throw new MessagingRuleError('not_authorized', 'Only the sender may edit their message');
    }

    if (msg.deletedAt !== undefined) {
      throw new MessagingRuleError('invalid_transition', 'Cannot edit a deleted message');
    }

    const trimmed = body.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_MESSAGE_LENGTH) {
      throw new MessagingRuleError(
        'invalid_body',
        `Message body must be non-empty and at most ${MAX_MESSAGE_LENGTH} characters`
      );
    }

    const updated: Message = {
      ...msg,
      body: trimmed,
      editedAt: at,
    };
    this.messages.set(messageId, updated);
    return updated;
  }

  async deleteMessage(
    messageId: MessageId,
    actorId: PlayerId,
    at: Date
  ): Promise<Message> {
    const msg = await this.findVisibleMessage(messageId, actorId);

    if (msg.senderId !== actorId) {
      throw new MessagingRuleError('not_authorized', 'Only the sender may delete their message');
    }

    if (msg.deletedAt !== undefined) {
      throw new MessagingRuleError('invalid_transition', 'Message is already deleted');
    }

    const tombstoned: Message = {
      ...msg,
      body: '',
      deletedAt: at,
    };
    this.messages.set(messageId, tombstoned);
    return tombstoned;
  }

  async listMessages(
    conversationId: ConversationId,
    actorId: PlayerId,
    options?: PageOptions
  ): Promise<Page<Message>> {
    // Throws not_found if conversation does not exist or actor is not a participant
    await this.getConversation(conversationId, actorId);

    const msgs = Array.from(this.messages.values())
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => compareOldestThenId(a.sentAt, a.id, b.sentAt, b.id));

    return paginate(msgs, options);
  }

  async markAsRead(
    conversationId: ConversationId,
    participantId: PlayerId,
    at: Date
  ): Promise<ConversationReadState> {
    // `not_found`, not `not_authorized`: a 403 here would tell a stranger that the id they guessed
    // is a real conversation, which is the enumeration invariant 7 exists to close.
    await this.getConversation(conversationId, participantId);

    const key = this.readKey(conversationId, participantId);
    const existing = this.reads.get(key);

    let lastReadAt = at;
    if (existing && existing.lastReadAt.getTime() > at.getTime()) {
      lastReadAt = existing.lastReadAt; // Monotonic check
    }

    const readState: ConversationReadState = {
      conversationId,
      participantId,
      lastReadAt,
    };

    this.reads.set(key, readState);
    return readState;
  }

  async getUnreadCount(participantId: PlayerId): Promise<number> {
    let totalUnread = 0;

    for (const conv of this.conversations.values()) {
      if (conv.participantA !== participantId && conv.participantB !== participantId) {
        continue;
      }

      const readState = this.reads.get(this.readKey(conv.id, participantId));
      const lastReadAt = readState?.lastReadAt;

      const unreadInConv = Array.from(this.messages.values()).filter(
        (m) =>
          m.conversationId === conv.id &&
          m.senderId !== participantId &&
          m.deletedAt === undefined &&
          (lastReadAt === undefined || m.sentAt > lastReadAt)
      ).length;

      totalUnread += unreadInConv;
    }

    return totalUnread;
  }
}
