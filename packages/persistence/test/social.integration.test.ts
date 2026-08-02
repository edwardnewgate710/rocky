import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { join } from 'node:path';
import { createPool } from '../src/pg/pool';
import { migrate } from '../src/pg/migrate';
import { PgSocialGraphRepository } from '../src/pg/social';
import { uuidv7 } from '../src/ids';
import { SocialRuleError } from '@chess-platform/social';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

test('pg social graph repository integration tests', { skip }, async () => {
  const pool = createPool();
  await migrate(pool, join(process.cwd(), 'migrations'));

  const repo = new PgSocialGraphRepository(pool);

  // Fixture user creation helper
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
    const dave = await createUser('Dave');

    // --- Invariant 1: self-relation rejection ---
    await assert.rejects(
      async () => repo.follow(alice, alice, new Date()),
      (err: any) => err instanceof SocialRuleError && err.code === 'self_relation'
    );
    await assert.rejects(
      async () => repo.unfollow(alice, alice),
      (err: any) => err instanceof SocialRuleError && err.code === 'self_relation'
    );
    await assert.rejects(
      async () => repo.sendFriendRequest(uuidv7(), alice, alice, new Date()),
      (err: any) => err instanceof SocialRuleError && err.code === 'self_relation'
    );
    await assert.rejects(
      async () => repo.block(alice, alice, new Date()),
      (err: any) => err instanceof SocialRuleError && err.code === 'self_relation'
    );
    await assert.rejects(
      async () => repo.unblock(alice, alice),
      (err: any) => err instanceof SocialRuleError && err.code === 'self_relation'
    );

    // --- Invariant 3: follow idempotency & unfollow ---
    const t1 = new Date('2026-08-01T10:00:00Z');
    const t2 = new Date('2026-08-01T11:00:00Z');

    const followEdge1 = await repo.follow(alice, bob, t1);
    assert.equal(followEdge1.followerId, alice);
    assert.equal(followEdge1.followeeId, bob);
    assert.equal(followEdge1.followedAt.getTime(), t1.getTime());

    // Re-following returns existing edge with original timestamp
    const followEdgeRe = await repo.follow(alice, bob, t2);
    assert.equal(followEdgeRe.followedAt.getTime(), t1.getTime());

    assert.equal(await repo.isFollowing(alice, bob), true);
    assert.equal(await repo.isFollowing(bob, alice), false);

    assert.equal(await repo.unfollow(alice, bob), true);
    assert.equal(await repo.unfollow(alice, bob), false);
    assert.equal(await repo.isFollowing(alice, bob), false);

    // --- Invariant 2 & 4: block precedence, atomic block, unblock ---
    // Establish relations between Alice and Bob:
    // Alice follows Bob, Bob follows Alice
    await repo.follow(alice, bob, t1);
    await repo.follow(bob, alice, t1);

    // Pending friend request from Alice to Bob
    const req1Id = uuidv7();
    await repo.sendFriendRequest(req1Id, alice, bob, t1);

    // Accepted friendship between Alice and Charlie
    const req2Id = uuidv7();
    await repo.sendFriendRequest(req2Id, alice, charlie, t1);
    await repo.respondToFriendRequest(req2Id, 'accept', charlie, t2);
    assert.equal(await repo.areFriends(alice, charlie), true);

    // Now Alice blocks Bob
    const blockTime = new Date('2026-08-01T12:00:00Z');
    const blockEdge = await repo.block(alice, bob, blockTime);
    assert.equal(blockEdge.blockerId, alice);
    assert.equal(blockEdge.blockedId, bob);
    assert.equal(blockEdge.blockedAt.getTime(), blockTime.getTime());

    // Atomic block verification:
    // 1. Follow edges in BOTH directions removed
    assert.equal(await repo.isFollowing(alice, bob), false);
    assert.equal(await repo.isFollowing(bob, alice), false);

    // 2. Pending request (Alice->Bob) cancelled by Alice's block
    const req1State = await repo.findFriendRequest(req1Id);
    assert.equal(req1State?.status, 'cancelled');

    // 3. Block precedence (Invariant 2): neither Alice (blocker) nor Bob (blocked) can follow or send friend requests to each other
    await assert.rejects(
      async () => repo.follow(alice, bob, new Date()),
      (err: any) => err instanceof SocialRuleError && err.code === 'blocked'
    );
    await assert.rejects(
      async () => repo.follow(bob, alice, new Date()),
      (err: any) => err instanceof SocialRuleError && err.code === 'blocked'
    );
    await assert.rejects(
      async () => repo.sendFriendRequest(uuidv7(), alice, bob, new Date()),
      (err: any) => err instanceof SocialRuleError && err.code === 'blocked'
    );
    await assert.rejects(
      async () => repo.sendFriendRequest(uuidv7(), bob, alice, new Date()),
      (err: any) => err instanceof SocialRuleError && err.code === 'blocked'
    );

    // Now Alice blocks Charlie (who has accepted friendship)
    await repo.block(alice, charlie, blockTime);
    const req2State = await repo.findFriendRequest(req2Id);
    assert.equal(req2State?.status, 'ended');
    assert.equal(await repo.areFriends(alice, charlie), false);

    // --- Invariant 5: unblock restores nothing ---
    assert.equal(await repo.unblock(alice, bob), true);
    assert.equal(await repo.unblock(alice, bob), false);
    assert.equal(await repo.isBlockedBetween(alice, bob), false);
    // Follows and friend requests remain gone/cancelled/ended
    assert.equal(await repo.isFollowing(alice, bob), false);
    assert.equal(await repo.isFollowing(bob, alice), false);
    assert.equal((await repo.findFriendRequest(req1Id))?.status, 'cancelled');

    // Clean unblock for charlie
    await repo.unblock(alice, charlie);

    // --- Invariant 6: sendFriendRequest rules ---
    const req3Id = uuidv7();
    await repo.sendFriendRequest(req3Id, alice, bob, t1);

    // Duplicate ID rejected
    await assert.rejects(
      async () => repo.sendFriendRequest(req3Id, charlie, dave, t1),
      (err: any) => err instanceof SocialRuleError && err.code === 'already_exists'
    );

    // Same direction pending request rejected
    await assert.rejects(
      async () => repo.sendFriendRequest(uuidv7(), alice, bob, t2),
      (err: any) => err instanceof SocialRuleError && err.code === 'already_exists'
    );

    // Opposite direction pending request rejected
    await assert.rejects(
      async () => repo.sendFriendRequest(uuidv7(), bob, alice, t2),
      (err: any) => err instanceof SocialRuleError && err.code === 'already_exists'
    );

    // Bob accepts
    await repo.respondToFriendRequest(req3Id, 'accept', bob, t2);
    assert.equal(await repo.areFriends(alice, bob), true);

    // Request between existing friends rejected
    await assert.rejects(
      async () => repo.sendFriendRequest(uuidv7(), alice, bob, new Date()),
      (err: any) => err instanceof SocialRuleError && err.code === 'already_exists'
    );

    // --- Invariant 7: list ordering, tie-break on identical timestamp, and pagination ---
    const sameTime = new Date('2026-08-01T15:00:00Z');
    // Alice follows Bob, Charlie, Dave at the exact same timestamp
    await repo.unfollow(alice, bob);
    await repo.follow(alice, bob, sameTime);
    await repo.follow(alice, charlie, sameTime);
    await repo.follow(alice, dave, sameTime);

    const followingPage = await repo.listFollowing(alice, { limit: 10, offset: 0 });
    assert.equal(followingPage.total, 3);
    // On identical timestamp, order tie-breaks by counterpart ID ASC
    const expectedIds = [bob, charlie, dave].sort();
    assert.deepEqual(
      followingPage.items.map((e) => e.followeeId),
      expectedIds
    );

    // Pagination clamping and slicing
    const page1 = await repo.listFollowing(alice, { limit: 2, offset: 0 });
    assert.equal(page1.total, 3);
    assert.equal(page1.items.length, 2);
    assert.deepEqual(page1.items.map((e) => e.followeeId), expectedIds.slice(0, 2));

    const page2 = await repo.listFollowing(alice, { limit: 2, offset: 2 });
    assert.equal(page2.total, 3);
    assert.equal(page2.items.length, 1);
    assert.deepEqual(page2.items.map((e) => e.followeeId), expectedIds.slice(2, 3));

    // NaN limit/offset clamping
    const nanPage = await repo.listFollowing(alice, { limit: NaN, offset: NaN });
    assert.equal(nanPage.total, 3);
    assert.equal(nanPage.items.length, 0);

    // Infinity is a legal PageOptions value that `Array.slice` absorbs, so the in-memory adapter
    // never had to think about it. Postgres rejects it as a malformed bigint, so an unguarded
    // adapter throws where the port contract promises a page.
    const infiniteLimit = await repo.listFollowing(alice, { limit: Infinity, offset: 0 });
    assert.equal(infiniteLimit.total, 3);
    assert.equal(infiniteLimit.items.length, 3, 'an infinite limit means "all remaining"');

    const infiniteOffset = await repo.listFollowing(alice, { limit: 10, offset: Infinity });
    assert.equal(infiniteOffset.total, 3, 'total is independent of the page window');
    assert.equal(infiniteOffset.items.length, 0, 'an infinite offset lands past the end');

    // --- Partial unique index assertions (bypassing domain straight through SQL) ---
    // 1. One pending request per pair
    const directReqId1 = uuidv7();
    const directReqId2 = uuidv7();
    await pool.query(
      `INSERT INTO social_friend_requests (id, requester_id, addressee_id, status, created_at)
       VALUES ($1, $2, $3, 'pending', NOW())`,
      [directReqId1, charlie, dave]
    );

    await assert.rejects(
      async () =>
        pool.query(
          `INSERT INTO social_friend_requests (id, requester_id, addressee_id, status, created_at)
           VALUES ($1, $2, $3, 'pending', NOW())`,
          [directReqId2, dave, charlie]
        ),
      (err: any) => err?.code === '23505' // unique_violation
    );

    // 2. One accepted request per pair
    await pool.query(
      `UPDATE social_friend_requests SET status = 'accepted', responded_at = NOW() WHERE id = $1`,
      [directReqId1]
    );

    await assert.rejects(
      async () =>
        pool.query(
          `INSERT INTO social_friend_requests (id, requester_id, addressee_id, status, created_at, responded_at)
           VALUES ($1, $2, $3, 'accepted', NOW(), NOW())`,
          [directReqId2, charlie, dave]
        ),
      (err: any) => err?.code === '23505' // unique_violation
    );

    // --- ON DELETE CASCADE assertion ---
    const cascadeUser = await createUser('CascadeUser');
    const cFollower = await createUser('CFollower');
    await repo.follow(cFollower, cascadeUser, sameTime);
    const cReqId = uuidv7();
    await repo.sendFriendRequest(cReqId, cFollower, cascadeUser, sameTime);
    await repo.block(cascadeUser, cFollower, sameTime);

    // Delete cascadeUser from users table
    await pool.query(`DELETE FROM users WHERE id = $1`, [cascadeUser]);

    // Verify follows, blocks, and requests referencing cascadeUser were deleted
    const followCheck = await pool.query(`SELECT 1 FROM social_follows WHERE follower_id = $1 OR followee_id = $1`, [cascadeUser]);
    assert.equal(followCheck.rowCount, 0);

    const blockCheck = await pool.query(`SELECT 1 FROM social_blocks WHERE blocker_id = $1 OR blocked_id = $1`, [cascadeUser]);
    assert.equal(blockCheck.rowCount, 0);

    const reqCheck = await pool.query(`SELECT 1 FROM social_friend_requests WHERE requester_id = $1 OR addressee_id = $1`, [cascadeUser]);
    assert.equal(reqCheck.rowCount, 0);

    // --- A player id that is well-formed but belongs to nobody ---
    // `parseUuid` at the route proves the shape and nothing proves the player exists, so the users
    // FK is what catches it. Unmapped it escapes as a raw driver error and the caller gets a 500
    // for what is really "no such player".
    const ghost = uuidv7();
    for (const [label, act] of [
      ['follow', async () => repo.follow(alice, ghost, new Date())],
      ['block', async () => repo.block(alice, ghost, new Date())],
      ['sendFriendRequest', async () => repo.sendFriendRequest(uuidv7(), alice, ghost, new Date())],
    ] as const) {
      await assert.rejects(
        act,
        (err: any) => err instanceof SocialRuleError && err.code === 'not_found',
        `${label} against a non-existent player must be not_found, not a driver error`
      );
    }

    // --- Concurrency: two responses to one request must not both win ---
    // Read-then-write across two pool connections is a lost update: both callers see 'pending',
    // both compute a legal transition, and the second UPDATE overwrites the first — so an accepted
    // friendship becomes a cancellation that was never valid. The fix reads inside the transaction
    // with FOR UPDATE, so the second caller sees the committed status and is refused.
    const raceA = await createUser('RaceA');
    const raceB = await createUser('RaceB');
    const raceReqId = uuidv7();
    await repo.sendFriendRequest(raceReqId, raceA, raceB, new Date());

    // Simply firing two responses at once does NOT reproduce this — they serialize on the pool and
    // never interleave, so that version of the test passed against the broken adapter too. The
    // interleaving has to be staged: hold the row locked from outside while another actor resolves
    // it, and only then let the adapter read.
    const holder = await pool.connect();
    let raceOutcome: 'resolved' | 'rejected';
    try {
      await holder.query('BEGIN');
      await holder.query(
        `UPDATE social_friend_requests SET status = 'accepted', responded_at = NOW() WHERE id = $1`,
        [raceReqId]
      );

      // Reading outside the transaction sees the last COMMITTED value — still 'pending'.
      const pending = repo.respondToFriendRequest(raceReqId, 'cancel', raceA, new Date());
      const settled = pending.then(
        () => 'resolved' as const,
        () => 'rejected' as const
      );
      await setTimeout(250); // let the adapter reach its SELECT while the row is still locked
      await holder.query('COMMIT');
      raceOutcome = await settled;
    } finally {
      holder.release();
    }

    assert.equal(
      raceOutcome,
      'rejected',
      'cancelling a request that was accepted while we were reading must be refused'
    );
    const raceFinal = await repo.findFriendRequest(raceReqId);
    assert.equal(raceFinal?.status, 'accepted', 'the committed acceptance must not be clobbered');

    // --- Concurrency: a follow must never survive a block committed alongside it ---
    // Whichever order the pair serializes in, only two outcomes are consistent: the follow lands
    // first and the block tears it down, or the block lands first and the follow is refused. A
    // surviving follow means the blocked player still follows the person who blocked them.
    const raceC = await createUser('RaceC');
    const raceD = await createUser('RaceD');
    await Promise.allSettled([
      repo.follow(raceC, raceD, new Date()),
      repo.block(raceD, raceC, new Date()),
    ]);

    assert.equal(await repo.isBlockedBetween(raceC, raceD), true, 'the block must stand');
    assert.equal(
      await repo.isFollowing(raceC, raceD),
      false,
      'no follow may outlive a block on the same pair'
    );

    // --- Concurrency: re-blocking during an in-flight unblock must not report a phantom block ---
    // The failure this guards against was silent, which is why it needs staging rather than luck.
    // With SELECT-then-INSERT, `block()` reads the still-visible old row version while an
    // uncommitted DELETE holds it, concludes "already blocked", skips the INSERT and returns a
    // BlockEdge — and then the DELETE commits, leaving a caller who was told they were protected
    // with no block row at all. The single-statement upsert takes the row lock instead: it waits
    // out the deleting transaction and inserts afresh.
    const raceE = await createUser('RaceE');
    const raceF = await createUser('RaceF');
    await repo.block(raceE, raceF, new Date('2026-08-01T16:00:00Z'));

    const unblockHolder = await pool.connect();
    try {
      await unblockHolder.query('BEGIN');
      await unblockHolder.query(
        `DELETE FROM social_blocks WHERE blocker_id = $1 AND blocked_id = $2`,
        [raceE, raceF]
      );

      const reblock = repo.block(raceE, raceF, new Date('2026-08-01T16:00:05Z'));
      await setTimeout(250); // let block() reach the upsert while the delete is still uncommitted
      await unblockHolder.query('COMMIT');
      await reblock;
    } finally {
      unblockHolder.release();
    }

    assert.equal(
      await repo.isBlockedBetween(raceE, raceF),
      true,
      'block() must not report success for a block the concurrent unblock removed'
    );

  } finally {
    // Scoped cleanup: delete only test users created during this run
    if (createdUserIds.length > 0) {
      await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUserIds]);
    }
    await pool.end();
  }
});
