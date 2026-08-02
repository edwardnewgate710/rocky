import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryMessagingRepository,
  MessagingRuleError,
  MAX_MESSAGE_LENGTH,
  normalizePair,
  compareOldestThenId,
  compareRecentActivityThenId,
  paginate,
} from '../src';

describe('@chess-platform/messaging domain rules', () => {
  it('normalizes pairs correctly in code-point order', () => {
    assert.deepEqual(normalizePair('user-b', 'user-a'), ['user-a', 'user-b']);
    assert.deepEqual(normalizePair('user-a', 'user-b'), ['user-a', 'user-b']);
  });

  it('rule 1: rejects opening a conversation or sending a message to oneself', async () => {
    const repo = new InMemoryMessagingRepository();
    const now = new Date('2026-08-02T10:00:00Z');

    await assert.rejects(
      () => repo.getOrCreateConversation('c1', 'user-a', 'user-a', now),
      (err: unknown) => err instanceof MessagingRuleError && err.code === 'self_conversation'
    );
  });

  it('rule 2: refuses conversation opening or messaging when a block exists in either direction', async () => {
    const blockChecker = {
      isBlockedBetween: async (a: string, b: string) =>
        (a === 'user-a' && b === 'user-b') || (a === 'user-b' && b === 'user-a'),
    };
    const repo = new InMemoryMessagingRepository(blockChecker);
    const now = new Date('2026-08-02T10:00:00Z');

    await assert.rejects(
      () => repo.getOrCreateConversation('c1', 'user-a', 'user-b', now),
      (err: unknown) => err instanceof MessagingRuleError && err.code === 'blocked'
    );
  });

  it('rule 3: rejects empty, whitespace-only, or overlength message body, storing trimmed body otherwise', async () => {
    const repo = new InMemoryMessagingRepository();
    const now = new Date('2026-08-02T10:00:00Z');
    const conv = await repo.getOrCreateConversation('c1', 'user-a', 'user-b', now);

    await assert.rejects(
      () => repo.sendMessage('m1', conv.id, 'user-a', '   ', now),
      (err: unknown) => err instanceof MessagingRuleError && err.code === 'invalid_body'
    );

    const longBody = 'x'.repeat(MAX_MESSAGE_LENGTH + 1);
    await assert.rejects(
      () => repo.sendMessage('m2', conv.id, 'user-a', longBody, now),
      (err: unknown) => err instanceof MessagingRuleError && err.code === 'invalid_body'
    );

    const validMsg = await repo.sendMessage('m3', conv.id, 'user-a', '  hello world  ', now);
    assert.equal(validMsg.body, 'hello world');
  });

  it('rule 4: restricts editing and deleting to sender, tombstones on delete, prevents editing/double deleting tombstones', async () => {
    const repo = new InMemoryMessagingRepository();
    const t0 = new Date('2026-08-02T10:00:00Z');
    const t1 = new Date('2026-08-02T10:01:00Z');
    const t2 = new Date('2026-08-02T10:02:00Z');

    const conv = await repo.getOrCreateConversation('c1', 'user-a', 'user-b', t0);
    const msg = await repo.sendMessage('m1', conv.id, 'user-a', 'original message', t0);

    // Non-sender edit rejected
    await assert.rejects(
      () => repo.editMessage(msg.id, 'user-b', 'edited text', t1),
      (err: unknown) => err instanceof MessagingRuleError && err.code === 'not_authorized'
    );

    // Non-sender delete rejected
    await assert.rejects(
      () => repo.deleteMessage(msg.id, 'user-b', t1),
      (err: unknown) => err instanceof MessagingRuleError && err.code === 'not_authorized'
    );

    // Sender edit succeeds
    const edited = await repo.editMessage(msg.id, 'user-a', 'edited text', t1);
    assert.equal(edited.body, 'edited text');
    assert.equal(edited.editedAt?.getTime(), t1.getTime());

    // Sender delete tombstones message
    const tombstoned = await repo.deleteMessage(msg.id, 'user-a', t2);
    assert.equal(tombstoned.body, '');
    assert.equal(tombstoned.deletedAt?.getTime(), t2.getTime());

    // Editing a deleted message rejected
    await assert.rejects(
      () => repo.editMessage(msg.id, 'user-a', 'new text', t2),
      (err: unknown) => err instanceof MessagingRuleError && err.code === 'invalid_transition'
    );

    // Deleting a deleted message twice rejected
    await assert.rejects(
      () => repo.deleteMessage(msg.id, 'user-a', t2),
      (err: unknown) => err instanceof MessagingRuleError && err.code === 'invalid_transition'
    );
  });

  it('rule 5: monotonic read marking and non-participant restriction', async () => {
    const repo = new InMemoryMessagingRepository();
    const t0 = new Date('2026-08-02T10:00:00Z');
    const t1 = new Date('2026-08-02T10:10:00Z');
    const tPast = new Date('2026-08-02T10:05:00Z');

    const conv = await repo.getOrCreateConversation('c1', 'user-a', 'user-b', t0);

    // A stranger gets `not_found`, not `not_authorized`. The difference matters: a 403 here would
    // tell them the id they tried is a live conversation, which is the whole point of rule 6.
    await assert.rejects(
      () => repo.markAsRead(conv.id, 'user-c', t1),
      (err: unknown) => err instanceof MessagingRuleError && err.code === 'not_found'
    );

    // Participant marks read
    const read1 = await repo.markAsRead(conv.id, 'user-a', t1);
    assert.equal(read1.lastReadAt.getTime(), t1.getTime());

    // Monotonic: earlier timestamp does not move lastReadAt backwards
    const read2 = await repo.markAsRead(conv.id, 'user-a', tPast);
    assert.equal(read2.lastReadAt.getTime(), t1.getTime());
  });

  it('rule 6: unread count calculates correctly (excludes own and tombstoned messages)', async () => {
    const repo = new InMemoryMessagingRepository();
    const t0 = new Date('2026-08-02T10:00:00Z');
    const t1 = new Date('2026-08-02T10:01:00Z');
    const t2 = new Date('2026-08-02T10:02:00Z');
    const t3 = new Date('2026-08-02T10:03:00Z');

    const conv = await repo.getOrCreateConversation('c1', 'user-a', 'user-b', t0);

    // User A sends msg (should not count as unread for A)
    await repo.sendMessage('m1', conv.id, 'user-a', 'hi from a', t0);
    assert.equal(await repo.getUnreadCount('user-a'), 0);
    assert.equal(await repo.getUnreadCount('user-b'), 1);

    // User B sends 2 msgs
    const m2 = await repo.sendMessage('m2', conv.id, 'user-b', 'hi from b 1', t1);
    await repo.sendMessage('m3', conv.id, 'user-b', 'hi from b 2', t2);
    assert.equal(await repo.getUnreadCount('user-a'), 2);

    // Tombstoning m2 decreases A's unread count
    await repo.deleteMessage(m2.id, 'user-b', t3);
    assert.equal(await repo.getUnreadCount('user-a'), 1);

    // User A marks read at t3 -> unread count becomes 0
    await repo.markAsRead(conv.id, 'user-a', t3);
    assert.equal(await repo.getUnreadCount('user-a'), 0);
  });

  it('rule 7: non-participants receive not_found when attempting to access conversation or thread', async () => {
    const repo = new InMemoryMessagingRepository();
    const now = new Date('2026-08-02T10:00:00Z');
    const conv = await repo.getOrCreateConversation('c1', 'user-a', 'user-b', now);

    await assert.rejects(
      () => repo.getConversation(conv.id, 'user-c'),
      (err: unknown) => err instanceof MessagingRuleError && err.code === 'not_found'
    );

    await assert.rejects(
      () => repo.listMessages(conv.id, 'user-c'),
      (err: unknown) => err instanceof MessagingRuleError && err.code === 'not_found'
    );
  });

  it('rule 6: a stranger cannot tell a real message id from an invented one', async () => {
    const repo = new InMemoryMessagingRepository();
    const now = new Date('2026-08-02T10:00:00Z');
    const conv = await repo.getOrCreateConversation('c1', 'user-a', 'user-b', now);
    const msg = await repo.sendMessage('m1', conv.id, 'user-a', 'private', now);

    // The two answers a stranger can get must be indistinguishable. If a real id answered
    // `not_authorized` while an invented one answered `not_found`, the pair of responses would be
    // an oracle for "does this message exist" — and ids are UUIDv7, so guessing near a known one
    // is cheap.
    for (const targetId of [msg.id, 'm-does-not-exist']) {
      await assert.rejects(
        () => repo.editMessage(targetId, 'user-c', 'hijacked', now),
        (err: unknown) => err instanceof MessagingRuleError && err.code === 'not_found',
        `editing '${targetId}' as a stranger must be indistinguishable from a missing message`
      );
      await assert.rejects(
        () => repo.deleteMessage(targetId, 'user-c', now),
        (err: unknown) => err instanceof MessagingRuleError && err.code === 'not_found',
        `deleting '${targetId}' as a stranger must be indistinguishable from a missing message`
      );
    }

    // The other participant is a different case: they can already see the message, so refusing
    // them with `not_authorized` discloses nothing they did not have.
    await assert.rejects(
      () => repo.editMessage(msg.id, 'user-b', 'not mine', now),
      (err: unknown) => err instanceof MessagingRuleError && err.code === 'not_authorized'
    );
  });

  it('rule 8: message and conversation list ordering, code-point tie-break, and pagination', async () => {
    const repo = new InMemoryMessagingRepository();
    const t0 = new Date('2026-08-02T10:00:00Z');
    const tSame = new Date('2026-08-02T10:05:00Z');

    const conv = await repo.getOrCreateConversation('c1', 'user-a', 'user-b', t0);
    await repo.sendMessage('m-b', conv.id, 'user-a', 'msg B', tSame);
    await repo.sendMessage('m-a', conv.id, 'user-a', 'msg A', tSame);

    // Thread messages ordered oldest-first, tie-broken by message ID ASC in code-point order
    const msgs = await repo.listMessages(conv.id, 'user-a');
    assert.deepEqual(msgs.items.map((m) => m.id), ['m-a', 'm-b']);

    // Check comparator directly
    assert.ok(compareOldestThenId(tSame, 'm-a', tSame, 'm-b') < 0);
    assert.ok(compareRecentActivityThenId(tSame, 'c-a', tSame, 'c-b') < 0);

    // Pagination explicit NaN & limit/offset handling
    const sliced = paginate([1, 2, 3, 4, 5], { limit: NaN, offset: NaN });
    assert.equal(sliced.items.length, 0); // NaN limit clamps to 0
    assert.equal(sliced.total, 5);
  });
});
