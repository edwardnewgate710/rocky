import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { join } from 'node:path';
import { createPool } from '../src/pg/pool';
import { migrate } from '../src/pg/migrate';
import { PgCommunityRepository } from '../src/pg/community';
import { uuidv7 } from '../src/ids';
import { CommunityRuleError, MAX_TEAM_NAME_LENGTH } from '@chess-platform/community';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

test('pg community repository integration tests', { skip }, async () => {
  const pool = createPool();
  await migrate(pool, join(process.cwd(), 'migrations'));

  const repo = new PgCommunityRepository(pool);

  const createdUserIds: string[] = [];
  const createUser = async (name: string): Promise<string> => {
    const id = uuidv7();
    const handle = `usr-${name.toLowerCase()}-${id.slice(0, 8)}`;
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
    const t2 = new Date('2026-08-02T10:02:00Z');

    // 1. Team creation & single owner unique index
    const teamId1 = uuidv7();
    const team1 = await repo.createTeam(teamId1, 'pg-team-1', 'PG Team 1', 'Description', 'public', alice, t0);
    assert.equal(team1.id, teamId1);
    assert.equal(team1.createdBy, alice);

    // Slug unique index constraint
    const teamId2 = uuidv7();
    await assert.rejects(
      async () => repo.createTeam(teamId2, 'pg-team-1', 'Duplicate Slug', 'Desc', 'public', bob, t0),
      (err: any) => err instanceof CommunityRuleError && err.code === 'slug_taken'
    );

    // 2. Member join, promotion, and owner transfer
    await repo.joinTeam(teamId1, bob, t1);
    await repo.updateMemberRole(teamId1, alice, bob, 'admin');

    const transferRes = await repo.transferOwnership(teamId1, alice, bob);
    assert.equal(transferRes.oldOwner.role, 'admin');
    assert.equal(transferRes.newOwner.role, 'owner');

    // Storage constraint: partial unique index on owner role prevents duplicate owner
    await assert.rejects(
      async () => pool.query(
        `INSERT INTO community_memberships (team_id, player_id, role, joined_at) VALUES ($1, $2, 'owner', NOW())`,
        [teamId1, charlie]
      ),
      (err: any) => err && err.code === '23505' // unique_violation
    );

    // 3. Join requests & pending request unique index constraint
    const hiddenTeamId = uuidv7();
    await repo.createTeam(hiddenTeamId, 'pg-hidden-team', 'PG Hidden Team', 'Desc', 'private', alice, t0);
    const captureCreateError = async (teamId: string): Promise<CommunityRuleError> => {
      try {
        await repo.createJoinRequest(uuidv7(), teamId, charlie, t1);
        assert.fail('private or missing team must not accept a join request');
      } catch (err) {
        assert.ok(err instanceof CommunityRuleError);
        return err;
      }
    };
    const hidden = await captureCreateError(hiddenTeamId);
    const missing = await captureCreateError(uuidv7());
    assert.deepEqual(
      { code: hidden.code, message: hidden.message },
      { code: missing.code, message: missing.message }
    );

    const requestTeamId = uuidv7();
    await repo.createTeam(requestTeamId, 'pg-request-team', 'PG Request Team', 'Desc', 'public', alice, t0);

    const reqId1 = uuidv7();
    const req1 = await repo.createJoinRequest(reqId1, requestTeamId, charlie, t1);
    assert.equal(req1.status, 'pending');

    // Partial unique index for one pending request per (team, player)
    await assert.rejects(
      async () => repo.createJoinRequest(uuidv7(), requestTeamId, charlie, t2),
      (err: any) => err instanceof CommunityRuleError && err.code === 'already_requested'
    );

    // A direct public join resolves an existing pending request in the same transaction. A later
    // moderation attempt cannot change membership state through a stale request.
    const directRequestId = uuidv7();
    await repo.createJoinRequest(directRequestId, requestTeamId, bob, t1);
    const directMembership = await repo.joinTeam(requestTeamId, bob, t2);
    assert.equal(directMembership.joinedAt.toISOString(), t2.toISOString());
    assert.deepEqual(await repo.listOutgoingJoinRequests(bob), { total: 0, items: [] });
    await repo.updateMemberRole(requestTeamId, alice, bob, 'admin');
    await assert.rejects(
      () => repo.respondToJoinRequest(directRequestId, alice, 'accepted', new Date(t2.getTime() + 1_000)),
      (err: unknown) => err instanceof CommunityRuleError && err.code === 'invalid_transition'
    );
    const preservedMembership = await repo.getMembership(requestTeamId, bob, alice);
    assert.equal(preservedMembership?.role, 'admin');
    assert.equal(preservedMembership?.joinedAt.toISOString(), t2.toISOString());

    // Respond to join request
    const acceptedReq = await repo.respondToJoinRequest(reqId1, alice, 'accepted', t2);
    assert.equal(acceptedReq.status, 'accepted');

    // 4. Forum threads and posts
    const threadId = uuidv7();
    const postId = uuidv7();
    const { thread, post } = await repo.createThread(threadId, teamId1, bob, 'PG Thread Title', 'Initial post body', postId, t0);
    assert.equal(thread.title, 'PG Thread Title');
    assert.equal(post.body, 'Initial post body');

    // Tombstone delete post
    const deletedPost = await repo.deletePost(postId, bob, t1);
    assert.equal(deletedPost.body, '');
    assert.ok(deletedPost.deletedAt);

    // 5. Lock order: the team lock must come before any row lock, or two paths deadlock.
    //
    // `createJoinRequest` holds the team lock and then blocks on the join-request row through the
    // one-pending-per-player unique index. If `respondToJoinRequest` locked that row first and then
    // reached for the team lock, each would hold what the other wanted next and Postgres would
    // resolve it by killing one with SQLSTATE 40P01. This stages exactly that cycle: hold the team
    // lock, let the responder get as far as it can, then take the row from this side.
    //
    // Asserting instead that "an advisory lock blocks a second acquirer" would be testing Postgres,
    // not this adapter — and it passes whichever order the adapter uses.
    const concurrentTeamId = uuidv7();
    await repo.createTeam(concurrentTeamId, 'pg-concur-team', 'Concur Team', 'Desc', 'public', alice, t0);
    const raceReqId = uuidv7();
    await repo.createJoinRequest(raceReqId, concurrentTeamId, bob, t0);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('team:' || $1::text, 0))`,
        [concurrentTeamId]
      );

      const responding = repo
        .respondToJoinRequest(raceReqId, alice, 'accepted', t1)
        .then((req) => req.status, (err: unknown) => (err instanceof Error ? err.message : String(err)));

      await setTimeout(250); // let the responder reach its wait on the team lock

      await client.query(
        `SELECT id FROM community_join_requests WHERE id = $1 FOR UPDATE`,
        [raceReqId]
      );
      await client.query('COMMIT');

      assert.equal(
        await responding,
        'accepted',
        'respondToJoinRequest must take the team lock before the request row, or the lock orders deadlock'
      );
    } finally {
      client.release();
    }

    // 5b. A join request is visible to its requester and the team's admins only, so a stranger must
    // not be able to tell a real request id from an invented one.
    const probeReqId = uuidv7();
    const probeTeamId = uuidv7();
    await repo.createTeam(probeTeamId, 'pg-probe-team', 'Probe Team', 'Desc', 'public', alice, t0);
    await repo.createJoinRequest(probeReqId, probeTeamId, bob, t0);
    await repo.updateTeam(probeTeamId, alice, { visibility: 'private' }, t1);
    const bobOutgoing = await repo.listOutgoingJoinRequests(bob);
    assert.equal(bobOutgoing.total, 1);
    assert.equal(bobOutgoing.items[0].id, probeReqId);
    assert.deepEqual(await repo.listOutgoingJoinRequests(charlie), { total: 0, items: [] });
    for (const targetId of [probeReqId, uuidv7()]) {
      await assert.rejects(
        async () => repo.cancelJoinRequest(targetId, charlie, t1),
        (err: any) => err instanceof CommunityRuleError && err.code === 'not_found',
        `cancelling '${targetId}' as a stranger must look like a missing request`
      );
    }
    await repo.cancelJoinRequest(probeReqId, bob, t1);
    assert.deepEqual(await repo.listOutgoingJoinRequests(bob), { total: 0, items: [] });

    // 5c. A team id that is not a UUID at all. The in-memory adapter treats ids as plain strings and
    // simply misses, so nothing here was under test: against Postgres the same value is compared to
    // a `uuid` column and raises `invalid input syntax for type uuid`, which is not a domain error
    // and escapes as a 500. An id that cannot name any row must read as naming no row.
    for (const badId of ['not-a-uuid', 'chess-masters', '123']) {
      await assert.rejects(
        async () => repo.getTeam(badId, alice),
        (err: any) => err instanceof CommunityRuleError && err.code === 'not_found',
        `getTeam('${badId}') must be not_found, not a driver error`
      );
    }

    // And the slug lookup itself has to work against Postgres, which is the adapter the route will
    // actually be talking to.
    const slugTeam = await repo.getTeamBySlug('pg-probe-team', alice);
    assert.equal(slugTeam.id, probeTeamId);

    // 6. User deletion cascade
    const cascadeUser = await createUser('CascadeUser');
    const cascadeTeamId = uuidv7();
    await repo.createTeam(cascadeTeamId, 'cascade-team', 'Cascade Team', 'Desc', 'public', cascadeUser, t0);

    // Delete user
    await pool.query(`DELETE FROM users WHERE id = $1`, [cascadeUser]);

    // Team should be deleted by foreign key cascade
    await assert.rejects(
      async () => repo.getTeam(cascadeTeamId, alice),
      (err: any) => err instanceof CommunityRuleError && err.code === 'not_found'
    );

    // 7. listJoinRequests status filtering before pagination in PgCommunityRepository
    const filterTeamId = uuidv7();
    await repo.createTeam(filterTeamId, 'pg-filter-team', 'Filter Team', 'Desc', 'public', alice, t0);
    const r1Id = uuidv7();
    const r2Id = uuidv7();
    const r3Id = uuidv7();
    await repo.createJoinRequest(r1Id, filterTeamId, bob, t0);
    await repo.respondToJoinRequest(r1Id, alice, 'accepted', t1);
    await repo.createJoinRequest(r2Id, filterTeamId, charlie, t1);
    await repo.respondToJoinRequest(r2Id, alice, 'accepted', t2);
    await repo.createJoinRequest(r3Id, filterTeamId, await createUser('Dave'), t2);

    const filterAll = await repo.listJoinRequests(filterTeamId, alice);
    assert.equal(filterAll.total, 3);

    const filterPending = await repo.listJoinRequests(filterTeamId, alice, { status: 'pending', limit: 1, offset: 0 });
    assert.equal(filterPending.total, 1);
    assert.equal(filterPending.items.length, 1);
    assert.equal(filterPending.items[0].id, r3Id);

    const filterPendingEmpty = await repo.listJoinRequests(filterTeamId, alice, { status: 'pending', limit: 1, offset: 1 });
    assert.equal(filterPendingEmpty.total, 1);
    assert.equal(filterPendingEmpty.items.length, 0);

    const outgoingIndex = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = current_schema()
         AND indexname = 'community_join_requests_pending_by_player_idx'`
    );
    assert.equal(outgoingIndex.rows.length, 1);
    assert.match(
      outgoingIndex.rows[0].indexdef,
      /\(player_id, created_at DESC, id(?: ASC)?\)/
    );
    assert.match(outgoingIndex.rows[0].indexdef, /WHERE .*status.*pending/);
  } finally {
    // Cleanup created users
    if (createdUserIds.length > 0) {
      await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [createdUserIds]);
    }
    await pool.end();
  }
});
