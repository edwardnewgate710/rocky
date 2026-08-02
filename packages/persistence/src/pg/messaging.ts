/**
 * @packageDocumentation
 * PostgreSQL implementation of MessagingRepository from @chess-platform/messaging.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  BlockChecker,
  Conversation,
  ConversationId,
  ConversationReadState,
  ConversationSummary,
  Message,
  MessageId,
  MessagingRepository,
  Page,
  PageOptions,
  PlayerId,
} from '@chess-platform/messaging';
import {
  assertDistinctParticipants,
  MAX_MESSAGE_LENGTH,
  MessagingRuleError,
  normalizePair,
} from '@chess-platform/messaging';
import { lockPlayerPair } from './pair-lock';
import { isForeignKeyViolation } from './sqlstate';

/**
 * Turns "that player row is not there" into the domain's own `not_found` rather than letting a raw
 * driver error escape as a 500. The ids reaching these inserts are user-controlled and only
 * *shaped* like players — `parseUuid` proves the format, never the existence.
 */
function rethrowMissingPlayer(err: unknown): never {
  if (isForeignKeyViolation(err)) {
    throw new MessagingRuleError('not_found', 'One of the players does not exist');
  }
  throw err;
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    /* ignore */
  }
}

/**
 * Serializes writes concerning one unordered pair of players for the duration of the transaction.
 *
 * The key is shared with the social graph adapter deliberately — see `./pair-lock`. It is what
 * makes the block check in `sendMessage` mean anything, because that check reads `social_blocks`
 * on another connection where a concurrent `block()` would otherwise be invisible until too late.
 */
async function lockPair(client: PoolClient, a: PlayerId, b: PlayerId): Promise<void> {
  await lockPlayerPair(client, a, b);
}

function normalizeOffset(offset?: number): number {
  if (offset === undefined || Number.isNaN(offset)) {
    return 0;
  }
  if (offset === Number.POSITIVE_INFINITY) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(0, Math.trunc(offset));
}

function normalizeLimit(limit?: number): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  if (Number.isNaN(limit)) {
    return 0;
  }
  if (limit === Number.POSITIVE_INFINITY) {
    return undefined;
  }
  return Math.max(0, Math.trunc(limit));
}

function paginationClause(params: unknown[], options?: PageOptions): string {
  const offset = normalizeOffset(options?.offset);
  const limit = normalizeLimit(options?.limit);

  let clause = `OFFSET $${params.push(offset)}`;
  if (limit !== undefined) {
    clause = `LIMIT $${params.push(limit)} ${clause}`;
  }
  return clause;
}

interface ConversationRow {
  id: string;
  participant_a: string;
  participant_b: string;
  created_at: Date;
  last_message_at: Date;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  sent_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
}

function rowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    participantA: row.participant_a,
    participantB: row.participant_b,
    createdAt: new Date(row.created_at),
    lastMessageAt: new Date(row.last_message_at),
  };
}

/** A conversation row with its unread count and newest message folded in by `listConversations`. */
interface ConversationSummaryRow extends ConversationRow {
  unread_count: string;
  lm_id: string | null;
  lm_sender_id: string | null;
  lm_body: string | null;
  lm_sent_at: Date | null;
  lm_edited_at: Date | null;
  lm_deleted_at: Date | null;
}

/**
 * The `LEFT JOIN LATERAL` either matched one message or filled every `lm_*` column with NULL, so
 * the columns move together. Checking each one rather than asserting on `lm_id` is what lets the
 * compiler see that, instead of being told to stop asking.
 */
function lastMessageFromRow(row: ConversationSummaryRow): Message | null {
  if (
    row.lm_id === null ||
    row.lm_sender_id === null ||
    row.lm_body === null ||
    row.lm_sent_at === null
  ) {
    return null;
  }
  return rowToMessage({
    id: row.lm_id,
    conversation_id: row.id,
    sender_id: row.lm_sender_id,
    body: row.lm_body,
    sent_at: row.lm_sent_at,
    edited_at: row.lm_edited_at,
    deleted_at: row.lm_deleted_at,
  });
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    body: row.body,
    sentAt: new Date(row.sent_at),
    ...(row.edited_at ? { editedAt: new Date(row.edited_at) } : {}),
    ...(row.deleted_at ? { deletedAt: new Date(row.deleted_at) } : {}),
  };
}

export class PgMessagingRepository implements MessagingRepository {
  constructor(
    private readonly pool: Pool,
    private readonly blockChecker: BlockChecker
  ) {}

  async getOrCreateConversation(
    id: ConversationId,
    participantA: PlayerId,
    participantB: PlayerId,
    at: Date
  ): Promise<Conversation> {
    assertDistinctParticipants(participantA, participantB);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockPair(client, participantA, participantB);

      if (await this.blockChecker.isBlockedBetween(participantA, participantB)) {
        throw new MessagingRuleError(
          'blocked',
          `Cannot start conversation because a block exists between ${participantA} and ${participantB}`
        );
      }

      const [pA, pB] = normalizePair(participantA, participantB);

      // Read first, insert only if absent. Elsewhere that shape is a race; here it is not, and the
      // difference is the pair lock held above: nothing else inserts into this table, and every
      // caller for this pair is queued behind us. (Rows do leave, but only by `users` cascade,
      // which takes the FK path below rather than racing this one.)
      //
      // The alternative — `ON CONFLICT ... DO UPDATE SET col = col` — buys atomicity we already
      // have and charges an UPDATE for it. Opening an existing chat is the common case on this
      // path, so that is a dead tuple and a WAL record every time a user clicks a conversation
      // they already have.
      const existing = await client.query<ConversationRow>(
        `SELECT id, participant_a, participant_b, created_at, last_message_at
         FROM messaging_conversations
         WHERE participant_a = $1 AND participant_b = $2`,
        [pA, pB]
      );

      let row: ConversationRow;
      if (existing.rows.length > 0) {
        row = existing.rows[0];
      } else {
        const inserted = await client.query<ConversationRow>(
          `INSERT INTO messaging_conversations (id, participant_a, participant_b, created_at, last_message_at)
           VALUES ($1, $2, $3, $4, $4)
           RETURNING id, participant_a, participant_b, created_at, last_message_at`,
          [id, pA, pB, at]
        ).catch(rethrowMissingPlayer);
        row = inserted.rows[0];
      }

      await client.query('COMMIT');
      return rowToConversation(row);
    } catch (err) {
      await rollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async getConversation(
    conversationId: ConversationId,
    actorId: PlayerId
  ): Promise<Conversation> {
    const res = await this.pool.query<ConversationRow>(
      `SELECT id, participant_a, participant_b, created_at, last_message_at
       FROM messaging_conversations
       WHERE id = $1`,
      [conversationId]
    );

    if (res.rows.length === 0) {
      throw new MessagingRuleError('not_found', `Conversation '${conversationId}' not found`);
    }

    const row = res.rows[0];
    if (row.participant_a !== actorId && row.participant_b !== actorId) {
      throw new MessagingRuleError('not_found', `Conversation '${conversationId}' not found`);
    }

    return rowToConversation(row);
  }

  async listConversations(
    participantId: PlayerId,
    options?: PageOptions
  ): Promise<Page<ConversationSummary>> {
    const countRes = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM messaging_conversations
       WHERE participant_a = $1 OR participant_b = $1`,
      [participantId]
    );
    const total = Number(countRes.rows[0]?.count ?? '0');

    const params: unknown[] = [participantId];
    const pagination = paginationClause(params, options);

    // One statement, not one per row. The obvious shape here — page the conversations, then loop
    // asking for each one's unread count and last message — is two extra round trips per row, so a
    // 50-item inbox costs 101 queries and the cost grows with the page size the caller chooses.
    // The unread count is a correlated subquery over the already-joined read marker, and the last
    // message is a LATERAL that stops at one row using the same index the thread listing uses.
    const convsRes = await this.pool.query<ConversationSummaryRow>(
      `SELECT c.id, c.participant_a, c.participant_b, c.created_at, c.last_message_at,
              (SELECT count(*)
                 FROM messaging_messages m
                WHERE m.conversation_id = c.id
                  AND m.sender_id <> $1
                  AND m.deleted_at IS NULL
                  AND (r.last_read_at IS NULL OR m.sent_at > r.last_read_at))::text AS unread_count,
              lm.id AS lm_id, lm.sender_id AS lm_sender_id, lm.body AS lm_body,
              lm.sent_at AS lm_sent_at, lm.edited_at AS lm_edited_at, lm.deleted_at AS lm_deleted_at
         FROM messaging_conversations c
         LEFT JOIN messaging_reads r
           ON r.conversation_id = c.id AND r.participant_id = $1
         LEFT JOIN LATERAL (
           SELECT id, sender_id, body, sent_at, edited_at, deleted_at
             FROM messaging_messages
            WHERE conversation_id = c.id
            ORDER BY sent_at DESC, id DESC
            LIMIT 1
         ) lm ON TRUE
        WHERE c.participant_a = $1 OR c.participant_b = $1
        ORDER BY c.last_message_at DESC, c.id ASC
        ${pagination}`,
      params
    );

    const items: ConversationSummary[] = convsRes.rows.map((row) => ({
      conversation: rowToConversation(row),
      unreadCount: Number(row.unread_count),
      lastMessage: lastMessageFromRow(row),
    }));

    return { total, items };
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

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Read the participants WITHOUT a row lock. Taking `FOR UPDATE` here and the advisory pair
      // lock afterwards is the wrong order: `getOrCreateConversation` takes the pair lock first and
      // then locks this same row through its `ON CONFLICT DO UPDATE`, so the two paths would hold
      // each other's next lock and Postgres would break the tie by killing one with a deadlock
      // error. The pair lock alone is enough here — nothing between this read and the insert
      // depends on the row staying still, because the only column this writes is `last_message_at`
      // and that write is expressed as a `GREATEST` rather than as a read-modify-write.
      const convRes = await client.query<ConversationRow>(
        `SELECT id, participant_a, participant_b, created_at, last_message_at
         FROM messaging_conversations
         WHERE id = $1`,
        [conversationId]
      );

      if (convRes.rows.length === 0) {
        throw new MessagingRuleError('not_found', `Conversation '${conversationId}' not found`);
      }

      const conv = convRes.rows[0];
      if (conv.participant_a !== senderId && conv.participant_b !== senderId) {
        throw new MessagingRuleError('not_found', `Conversation '${conversationId}' not found`);
      }

      const otherId = conv.participant_a === senderId ? conv.participant_b : conv.participant_a;
      await lockPair(client, senderId, otherId);

      if (await this.blockChecker.isBlockedBetween(senderId, otherId)) {
        throw new MessagingRuleError(
          'blocked',
          `Cannot send message because a block exists between ${senderId} and ${otherId}`
        );
      }

      await client.query(
        `INSERT INTO messaging_messages (id, conversation_id, sender_id, body, sent_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, conversationId, senderId, trimmed, at]
      );

      // GREATEST, not assignment: conversations are listed by this column, so a message that
      // commits late with an earlier timestamp must not drag the thread backwards past messages
      // already in it.
      await client.query(
        `UPDATE messaging_conversations
         SET last_message_at = GREATEST(last_message_at, $1)
         WHERE id = $2`,
        [at, conversationId]
      );

      await client.query('COMMIT');

      return {
        id,
        conversationId,
        senderId,
        body: trimmed,
        sentAt: at,
      };
    } catch (err) {
      await rollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async editMessage(
    messageId: MessageId,
    actorId: PlayerId,
    body: string,
    at: Date
  ): Promise<Message> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // The join to `messaging_conversations` is the authorization boundary, not decoration: a
      // message in a thread the actor is not part of must read as absent. Answering
      // `not_authorized` instead would confirm the id exists, and message ids are UUIDv7 — they
      // carry a timestamp, so ids near a known one are guessable.
      const res = await client.query<MessageRow>(
        `SELECT m.id, m.conversation_id, m.sender_id, m.body, m.sent_at, m.edited_at, m.deleted_at
         FROM messaging_messages m
         JOIN messaging_conversations c ON c.id = m.conversation_id
         WHERE m.id = $1 AND (c.participant_a = $2 OR c.participant_b = $2)
         FOR UPDATE OF m`,
        [messageId, actorId]
      );

      if (res.rows.length === 0) {
        throw new MessagingRuleError('not_found', `Message '${messageId}' not found`);
      }

      const msg = res.rows[0];
      if (msg.sender_id !== actorId) {
        throw new MessagingRuleError('not_authorized', 'Only the sender may edit their message');
      }

      if (msg.deleted_at !== null) {
        throw new MessagingRuleError('invalid_transition', 'Cannot edit a deleted message');
      }

      const trimmed = body.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_MESSAGE_LENGTH) {
        throw new MessagingRuleError(
          'invalid_body',
          `Message body must be non-empty and at most ${MAX_MESSAGE_LENGTH} characters`
        );
      }

      await client.query(
        `UPDATE messaging_messages SET body = $1, edited_at = $2 WHERE id = $3`,
        [trimmed, at, messageId]
      );

      await client.query('COMMIT');

      return {
        ...rowToMessage(msg),
        body: trimmed,
        editedAt: at,
      };
    } catch (err) {
      await rollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteMessage(
    messageId: MessageId,
    actorId: PlayerId,
    at: Date
  ): Promise<Message> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // The join to `messaging_conversations` is the authorization boundary, not decoration: a
      // message in a thread the actor is not part of must read as absent. Answering
      // `not_authorized` instead would confirm the id exists, and message ids are UUIDv7 — they
      // carry a timestamp, so ids near a known one are guessable.
      const res = await client.query<MessageRow>(
        `SELECT m.id, m.conversation_id, m.sender_id, m.body, m.sent_at, m.edited_at, m.deleted_at
         FROM messaging_messages m
         JOIN messaging_conversations c ON c.id = m.conversation_id
         WHERE m.id = $1 AND (c.participant_a = $2 OR c.participant_b = $2)
         FOR UPDATE OF m`,
        [messageId, actorId]
      );

      if (res.rows.length === 0) {
        throw new MessagingRuleError('not_found', `Message '${messageId}' not found`);
      }

      const msg = res.rows[0];
      if (msg.sender_id !== actorId) {
        throw new MessagingRuleError('not_authorized', 'Only the sender may delete their message');
      }

      if (msg.deleted_at !== null) {
        throw new MessagingRuleError('invalid_transition', 'Message is already deleted');
      }

      await client.query(
        `UPDATE messaging_messages SET body = '', deleted_at = $1 WHERE id = $2`,
        [at, messageId]
      );

      await client.query('COMMIT');

      return {
        ...rowToMessage(msg),
        body: '',
        deletedAt: at,
      };
    } catch (err) {
      await rollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async listMessages(
    conversationId: ConversationId,
    actorId: PlayerId,
    options?: PageOptions
  ): Promise<Page<Message>> {
    // Throws not_found if conversation does not exist or actor is not a participant
    await this.getConversation(conversationId, actorId);

    const countRes = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM messaging_messages WHERE conversation_id = $1`,
      [conversationId]
    );
    const total = Number(countRes.rows[0]?.count ?? '0');

    const params: unknown[] = [conversationId];
    const pagination = paginationClause(params, options);

    const res = await this.pool.query<MessageRow>(
      `SELECT id, conversation_id, sender_id, body, sent_at, edited_at, deleted_at
       FROM messaging_messages
       WHERE conversation_id = $1
       ORDER BY sent_at ASC, id ASC
       ${pagination}`,
      params
    );

    const items = res.rows.map(rowToMessage);
    return { total, items };
  }

  async markAsRead(
    conversationId: ConversationId,
    participantId: PlayerId,
    at: Date
  ): Promise<ConversationReadState> {
    // `not_found` for a stranger, not `not_authorized`: a 403 would confirm the conversation is
    // real, which is exactly the distinction `getConversation` refuses to make.
    await this.getConversation(conversationId, participantId);

    const res = await this.pool.query<{ conversation_id: string; participant_id: string; last_read_at: Date }>(
      `INSERT INTO messaging_reads (conversation_id, participant_id, last_read_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (conversation_id, participant_id)
       DO UPDATE SET last_read_at = GREATEST(messaging_reads.last_read_at, EXCLUDED.last_read_at)
       RETURNING conversation_id, participant_id, last_read_at`,
      [conversationId, participantId, at]
    );

    const row = res.rows[0];
    return {
      conversationId: row.conversation_id,
      participantId: row.participant_id,
      lastReadAt: new Date(row.last_read_at),
    };
  }

  async getUnreadCount(participantId: PlayerId): Promise<number> {
    const res = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM messaging_messages m
       JOIN messaging_conversations c ON c.id = m.conversation_id
       LEFT JOIN messaging_reads r ON r.conversation_id = m.conversation_id AND r.participant_id = $1
       WHERE (c.participant_a = $1 OR c.participant_b = $1)
         AND m.sender_id <> $1
         AND m.deleted_at IS NULL
         AND (r.last_read_at IS NULL OR m.sent_at > r.last_read_at)`,
      [participantId]
    );

    return Number(res.rows[0]?.count ?? '0');
  }
}
