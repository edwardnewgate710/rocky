import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { join } from 'node:path';
import { createPool } from '../src/pg/pool';
import { migrate } from '../src/pg/migrate';
import { PgMessagingRepository } from '../src/pg/messaging';
import { PgSocialGraphRepository } from '../src/pg/social';
import { uuidv7 } from '../src/ids';
import { MessagingRuleError, MAX_MESSAGE_LENGTH } from '@chess-platform/messaging';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

test('pg messaging repository integration tests', { skip }, async () => {
  const pool = createPool();
  await migrate(pool, join(process.cwd(), 'migrations'));

  const socialRepo = new PgSocialGraphRepository(pool);
  const repo = new PgMessagingRepository(pool, socialRepo);

  const createdUserIds: string[] = [];
  const createUser = async (name: string): Promise<string> => {
    const id = uuidv7();
    const handle = `user-${name.toLowerCase()}-${id.slice(0, 8)}`;
    await pool.query(
      `INSERT INTO users (id, handle, email_hash, created_at) VALUES ($1, $2, $3, NOW())`,
      [id, handle, Buffer.from(id)]
    );
    createdUserIds.push(id);
    return id;
  };

  try {
    const alice = await createUser('Alice');
    const bob = await createUser('Bob');
    const charlie = await createUser('Charlie');

    const t0 = new Date('2026-08-02T10:00:00Z');
    const t1 = new Date('2026-08-02T10:01:00Z');

    // 1. Self conversation rejection
    await assert.rejects(
      async () => repo.getOrCreateConversation(uuidv7(), alice, alice, t0),
      (err: any) => err instanceof MessagingRuleError && err.code === 'self_conversation'
    );

    // 2. Block check enforcement
    await socialRepo.block(alice, bob, t0);
    await assert.rejects(
      async () => repo.getOrCreateConversation(uuidv7(), alice, bob, t0),
      (err: any) => err instanceof MessagingRuleError && err.code === 'blocked'
    );
    await socialRepo.unblock(alice, bob);

    // 3. Conversation creation & idempotency
    const convId = uuidv7();
    const conv1 = await repo.getOrCreateConversation(convId, alice, bob, t0);
    assert.equal(conv1.id, convId);

    // Idempotent call returns existing conversation
    const conv1Re = await repo.getOrCreateConversation(uuidv7(), bob, alice, t1);
    assert.equal(conv1Re.id, convId);

    // 4. Message body validation and trimming
    await assert.rejects(
      async () => repo.sendMessage(uuidv7(), conv1.id, alice, '   ', t0),
      (err: any) => err instanceof MessagingRuleError && err.code === 'invalid_body'
    );

    const overlength = 'a'.repeat(MAX_MESSAGE_LENGTH + 1);
    await assert.rejects(
      async () => repo.sendMessage(uuidv7(), conv1.id, alice, overlength, t0),
      (err: any) => err instanceof MessagingRuleError && err.code === 'invalid_body'
    );

    const msgId1 = uuidv7();
    const msg1 = await repo.sendMessage(msgId1, conv1.id, alice, '  hello bob  ', t0);
    assert.equal(msg1.body, 'hello bob');

    // 5. Message edit and tombstone delete
    await assert.rejects(
      async () => repo.editMessage(msg1.id, bob, 'unauthorized edit', t1),
      (err: any) => err instanceof MessagingRuleError && err.code === 'not_authorized'
    );

    const edited = await repo.editMessage(msg1.id, alice, 'edited message', t1);
    assert.equal(edited.body, 'edited message');
    assert.ok(edited.editedAt);

    const tombstoned = await repo.deleteMessage(msg1.id, alice, t1);
    assert.equal(tombstoned.body, '');
    assert.ok(tombstoned.deletedAt);

    await assert.rejects(
      async () => repo.editMessage(msg1.id, alice, 'edit deleted', t1),
      (err: any) => err instanceof MessagingRuleError && err.code === 'invalid_transition'
    );

    // 6. Monotonic read state
    const read1 = await repo.markAsRead(conv1.id, bob, t1);
    assert.equal(read1.lastReadAt.getTime(), t1.getTime());

    const readPast = await repo.markAsRead(conv1.id, bob, t0);
    assert.equal(readPast.lastReadAt.getTime(), t1.getTime());

    // 7. A stranger cannot distinguish a real id from an invented one — for conversations, and for
    // messages inside them. `not_authorized` anywhere here would confirm the id is live.
    await assert.rejects(
      async () => repo.getConversation(conv1.id, charlie),
      (err: any) => err instanceof MessagingRuleError && err.code === 'not_found'
    );
    for (const targetId of [msg1.id, uuidv7()]) {
      await assert.rejects(
        async () => repo.editMessage(targetId, charlie, 'hijacked', t1),
        (err: any) => err instanceof MessagingRuleError && err.code === 'not_found',
        `editing '${targetId}' as a stranger must look like a missing message`
      );
      await assert.rejects(
        async () => repo.deleteMessage(targetId, charlie, t1),
        (err: any) => err instanceof MessagingRuleError && err.code === 'not_found',
        `deleting '${targetId}' as a stranger must look like a missing message`
      );
    }

    // 7b. A well-formed UUID that belongs to nobody is a request about someone who does not exist,
    // not a server fault. Unmapped, the users FK violation escapes the adapter as a raw driver
    // error and the route answers 500.
    await assert.rejects(
      async () => repo.getOrCreateConversation(uuidv7(), alice, uuidv7(), t0),
      (err: any) => err instanceof MessagingRuleError && err.code === 'not_found',
      'opening a conversation with a non-existent player must be not_found, not a driver error'
    );

    // 8. Pagination & NaN/Infinity safety
    const page = await repo.listMessages(conv1.id, alice, { limit: Infinity, offset: NaN });
    assert.equal(page.total, 1);

    // 9. Foreign Key Cascade Deletes
    const dummyA = await createUser('DummyA');
    const dummyB = await createUser('DummyB');
    const dummyConvId = uuidv7();
    const dummyConv = await repo.getOrCreateConversation(dummyConvId, dummyA, dummyB, t0);
    await repo.sendMessage(uuidv7(), dummyConv.id, dummyA, 'cascade test', t0);

    // Delete user DummyA
    await pool.query(`DELETE FROM users WHERE id = $1`, [dummyA]);

    const deletedConvCheck = await pool.query(
      `SELECT 1 FROM messaging_conversations WHERE id = $1`,
      [dummyConvId]
    );
    assert.equal(deletedConvCheck.rowCount, 0);

    // 10. Unique index on normalized pair
    const pairUser1 = await createUser('Pair1');
    const pairUser2 = await createUser('Pair2');
    const p1Id = uuidv7();
    const p2Id = uuidv7();

    const c1 = await repo.getOrCreateConversation(p1Id, pairUser1, pairUser2, t0);
    const c2 = await repo.getOrCreateConversation(p2Id, pairUser2, pairUser1, t1);
    assert.equal(c1.id, c2.id); // Same conversation returned via single-statement ON CONFLICT

    // Direct duplicate insert should fail on unique index
    await assert.rejects(async () => {
      await pool.query(
        `INSERT INTO messaging_conversations (id, participant_a, participant_b, created_at, last_message_at)
         VALUES ($1, LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid), $4, $4)`,
        [uuidv7(), pairUser1, pairUser2, t0]
      );
    });

    // 11. Concurrency test with staged outside transaction row lock
    const concUser1 = await createUser('Conc1');
    const concUser2 = await createUser('Conc2');
    const concConvId = uuidv7();
    const concConv = await repo.getOrCreateConversation(concConvId, concUser1, concUser2, t0);

    // `sendMessage` and `getOrCreateConversation` both need the advisory pair lock and the
    // conversation row, and if they take them in opposite orders the pair deadlocks. This stages
    // exactly that cycle: hold the pair lock, let sendMessage get as far as it can, then reach for
    // the conversation row from this side. An adapter that locked the row before waiting on the
    // pair lock would be holding what we want while waiting for what we hold, and Postgres would
    // break the tie by killing one of us with SQLSTATE 40P01.
    const deadlockClient = await pool.connect();
    try {
      await deadlockClient.query('BEGIN');
      await deadlockClient.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended(LEAST($1::text, $2::text) || '|' || GREATEST($1::text, $2::text), 0)
         )`,
        [concUser1, concUser2]
      );

      const send = repo.sendMessage(uuidv7(), concConv.id, concUser1, 'no deadlock', t1);
      const settled = send.then(
        (msg) => msg.body,
        (err: unknown) => (err instanceof Error ? err.message : String(err))
      );

      await setTimeout(250); // let sendMessage reach its wait on the pair lock

      await deadlockClient.query(
        `SELECT id FROM messaging_conversations WHERE id = $1 FOR UPDATE`,
        [concConv.id]
      );
      await deadlockClient.query('COMMIT');

      assert.equal(
        await settled,
        'no deadlock',
        'sendMessage must take the pair lock before any row lock, or the two lock orders deadlock'
      );
    } finally {
      deadlockClient.release();
    }

  } finally {
    // Cleanup fixture users
    if (createdUserIds.length > 0) {
      await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUserIds]);
    }
    await pool.end();
  }
});
