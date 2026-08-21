import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CommunityRuleError,
  InMemoryCommunityRepository,
  MAX_POST_BODY_LENGTH,
  MAX_TEAM_DESCRIPTION_LENGTH,
  MAX_TEAM_NAME_LENGTH,
  MAX_THREAD_TITLE_LENGTH,
} from '../src';

test('InMemoryCommunityRepository unit tests', async (t) => {
  const repo = new InMemoryCommunityRepository();
  const t0 = new Date('2026-08-02T10:00:00Z');
  const t1 = new Date('2026-08-02T10:01:00Z');
  const t2 = new Date('2026-08-02T10:02:00Z');

  const alice = '00000000-0000-7000-8000-000000000001';
  const bob = '00000000-0000-7000-8000-000000000002';
  const charlie = '00000000-0000-7000-8000-000000000003';
  const dave = '00000000-0000-7000-8000-000000000004';

  await t.test('1. Team ownership invariant & transfer', async () => {
    await repo.clear();
    const team = await repo.createTeam('t1', 'team-one', 'Team One', 'Desc', 'public', alice, t0);
    assert.equal(team.createdBy, alice);

    const mems = await repo.listMembers('t1', alice);
    assert.equal(mems.total, 1);
    assert.equal(mems.items[0].playerId, alice);
    assert.equal(mems.items[0].role, 'owner');

    // Owner cannot leave or be removed
    await assert.rejects(
      async () => repo.leaveOrRemoveMember('t1', alice, alice),
      (err: any) => err instanceof CommunityRuleError && err.code === 'cannot_leave_as_owner'
    );

    // Join bob and transfer ownership to bob
    await repo.joinTeam('t1', bob, t1);
    const transfer = await repo.transferOwnership('t1', alice, bob);
    assert.equal(transfer.oldOwner.role, 'admin');
    assert.equal(transfer.newOwner.role, 'owner');

    // Now old owner (alice) is admin and can leave
    await repo.leaveOrRemoveMember('t1', alice, alice);
    const memsAfter = await repo.listMembers('t1', bob);
    assert.equal(memsAfter.total, 1);
    assert.equal(memsAfter.items[0].playerId, bob);
  });

  await t.test('2. Role authority order and promotion/demotion/removal', async () => {
    await repo.clear();
    await repo.createTeam('t1', 'knights', 'Knights', 'Desc', 'public', alice, t0); // alice: owner
    await repo.joinTeam('t1', bob, t1); // bob: member
    await repo.joinTeam('t1', charlie, t1); // charlie: member

    // Alice (owner) promotes Bob to admin
    const bobAdmin = await repo.updateMemberRole('t1', alice, bob, 'admin');
    assert.equal(bobAdmin.role, 'admin');

    // Bob (admin) cannot promote Charlie to admin or owner (role at/above Bob's)
    await assert.rejects(
      async () => repo.updateMemberRole('t1', bob, charlie, 'admin'),
      (err: any) => err instanceof CommunityRuleError && err.code === 'not_authorized'
    );

    // Bob (admin) cannot change Alice (owner)'s role
    await assert.rejects(
      async () => repo.updateMemberRole('t1', bob, alice, 'member'),
      (err: any) => err instanceof CommunityRuleError && err.code === 'not_authorized'
    );

    // Bob (admin) can remove Charlie (member), but Charlie (member) cannot remove Bob (admin)
    await assert.rejects(
      async () => repo.leaveOrRemoveMember('t1', charlie, bob),
      (err: any) => err instanceof CommunityRuleError && err.code === 'not_authorized'
    );

    await repo.leaveOrRemoveMember('t1', bob, charlie);
    const members = await repo.listMembers('t1', alice);
    assert.equal(members.total, 2);
  });

  await t.test('3. Slugs normalization and character set rules', async () => {
    await repo.clear();
    // Uppercase slug rejected
    await assert.rejects(
      async () => repo.createTeam('t1', 'My-Team', 'Name', 'Desc', 'public', alice, t0),
      (err: any) => err instanceof CommunityRuleError && err.code === 'invalid_slug'
    );

    // Untrimmed slug rejected
    await assert.rejects(
      async () => repo.createTeam('t1', ' my-team ', 'Name', 'Desc', 'public', alice, t0),
      (err: any) => err instanceof CommunityRuleError && err.code === 'invalid_slug'
    );

    // Invalid character slug rejected
    await assert.rejects(
      async () => repo.createTeam('t1', 'team_one!', 'Name', 'Desc', 'public', alice, t0),
      (err: any) => err instanceof CommunityRuleError && err.code === 'invalid_slug'
    );

    // Valid slug accepted
    const team = await repo.createTeam('t1', 'valid-slug-1', 'Name', 'Desc', 'public', alice, t0);
    assert.equal(team.slug, 'valid-slug-1');

    // Duplicate slug rejected
    await assert.rejects(
      async () => repo.createTeam('t2', 'valid-slug-1', 'Name 2', 'Desc', 'public', bob, t0),
      (err: any) => err instanceof CommunityRuleError && err.code === 'slug_taken'
    );
  });

  await t.test('4. Public vs private team join & request lifecycle', async () => {
    await repo.clear();
    await repo.createTeam('pub', 'public-team', 'Public', '', 'public', alice, t0);
    await repo.createTeam('priv', 'private-team', 'Private', '', 'private', alice, t0);

    // Join public team directly
    const pubMem = await repo.joinTeam('pub', bob, t1);
    assert.equal(pubMem.role, 'member');

    // Join private team directly fails with not_found (Rule 8: private team is invisible to non-members)
    await assert.rejects(
      async () => repo.joinTeam('priv', bob, t1),
      (err: any) => err instanceof CommunityRuleError && err.code === 'not_found'
    );

    // Member cannot submit join request
    await assert.rejects(
      async () => repo.createJoinRequest('req-owner', 'priv', alice, t1),
      (err: any) => err instanceof CommunityRuleError && err.code === 'already_member'
    );

    const privateError = async (teamId: string): Promise<CommunityRuleError> => {
      try {
        await repo.createJoinRequest('private-probe', teamId, charlie, t1);
        assert.fail('private or missing team must not accept a join request');
      } catch (err) {
        assert.ok(err instanceof CommunityRuleError);
        return err;
      }
    };

    // A private team hidden from Charlie and a missing team are indistinguishable at the domain boundary.
    const hidden = await privateError('priv');
    const missing = await privateError('never-existed');
    assert.deepEqual(
      { code: hidden.code, message: hidden.message },
      { code: missing.code, message: missing.message }
    );

    // Public teams remain requestable.
    const req1 = await repo.createJoinRequest('r1', 'pub', charlie, t1);
    assert.equal(req1.status, 'pending');

    // Duplicate pending request rejected
    await assert.rejects(
      async () => repo.createJoinRequest('r1-duplicate', 'pub', charlie, t2),
      (err: any) => err instanceof CommunityRuleError && err.code === 'already_requested'
    );

    // Directly joining a public team resolves the caller's pending request atomically. A later
    // moderation attempt must not overwrite the membership role or original join time.
    await repo.createTeam('direct-request-team', 'direct-request-team', 'Direct Requests', '', 'public', alice, t0);
    await repo.createJoinRequest('direct-request', 'direct-request-team', charlie, t1);
    const directMembership = await repo.joinTeam('direct-request-team', charlie, t2);
    assert.equal(directMembership.joinedAt, t2);
    assert.deepEqual(await repo.listOutgoingJoinRequests(charlie), { total: 1, items: [req1] });
    await repo.updateMemberRole('direct-request-team', alice, charlie, 'admin');
    await assert.rejects(
      () => repo.respondToJoinRequest('direct-request', alice, 'accepted', new Date(t2.getTime() + 1_000)),
      (err: unknown) => err instanceof CommunityRuleError && err.code === 'invalid_transition'
    );
    const preservedMembership = await repo.getMembership('direct-request-team', charlie, alice);
    assert.equal(preservedMembership?.role, 'admin');
    assert.equal(preservedMembership?.joinedAt, t2);

    // A visible-team non-admin cannot respond to a request.
    await assert.rejects(
      async () => repo.respondToJoinRequest('r1', dave, 'accepted', t2),
      (err: any) => err instanceof CommunityRuleError && err.code === 'not_authorized'
    );

    // Alice (owner) accepts Charlie's request. Responded requests leave the requester self-list.
    const accepted = await repo.respondToJoinRequest('r1', alice, 'accepted', t2);
    assert.equal(accepted.status, 'accepted');
    const charlieMem = await repo.getMembership('pub', charlie, alice);
    assert.ok(charlieMem);
    assert.deepEqual(await repo.listOutgoingJoinRequests(charlie), { total: 0, items: [] });

    // A legacy pending request remains recoverable after its team becomes private, but only by its requester.
    await repo.createTeam('request-team', 'request-team', 'Requests', '', 'public', alice, t0);
    await repo.createJoinRequest('r2', 'request-team', dave, t2);
    await repo.updateTeam('request-team', alice, { visibility: 'private' }, t2);
    const outgoing = await repo.listOutgoingJoinRequests(dave);
    assert.equal(outgoing.total, 1);
    assert.equal(outgoing.items[0].id, 'r2');
    assert.equal(outgoing.items[0].teamId, 'request-team');
    assert.deepEqual(await repo.listOutgoingJoinRequests(bob), { total: 0, items: [] });

    // A stranger must get the same answer for a real request id and an invented one.
    // A join request is visible to its requester and the team's admins; `not_authorized` on a live
    // id while an invented one answers `not_found` is an oracle over request ids (invariant 8).
    for (const targetId of ['r2', 'r-never-existed']) {
      await assert.rejects(
        () => repo.cancelJoinRequest(targetId, bob, t2),
        (err: unknown) => err instanceof CommunityRuleError && err.code === 'not_found',
        `cancelling '${targetId}' as a stranger must look like a missing request`
      );
    }

    const cancelled = await repo.cancelJoinRequest('r2', dave, t2);
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(await repo.listOutgoingJoinRequests(dave), { total: 0, items: [] });
  });

  await t.test('5. Public vs private team visibility & forum access', async () => {
    await repo.clear();
    await repo.createTeam('pub', 'public-team', 'Public', '', 'public', alice, t0);
    await repo.createTeam('priv', 'private-team', 'Private', '', 'private', alice, t0);

    // Non-member bob can read public team
    const pubTeam = await repo.getTeam('pub', bob);
    assert.equal(pubTeam.id, 'pub');

    // Non-member bob reading private team returns not_found
    await assert.rejects(
      async () => repo.getTeam('priv', bob),
      (err: any) => err instanceof CommunityRuleError && err.code === 'not_found'
    );

    // Non-member bob attempting to post in public team forum returns not_authorized
    const { thread } = await repo.createThread('th-pub', 'pub', alice, 'Welcome', 'Hello', 'p1', t0);
    await assert.rejects(
      async () => repo.createPost('p2', 'th-pub', bob, 'Comment by stranger', t1),
      (err: any) => err instanceof CommunityRuleError && err.code === 'not_authorized'
    );

    // Non-member bob attempting to read private team thread returns not_found
    const { thread: privThread } = await repo.createThread('th-priv', 'priv', alice, 'Secret', 'Shh', 'p-priv1', t0);
    await assert.rejects(
      async () => repo.getThread('th-priv', bob),
      (err: any) => err instanceof CommunityRuleError && err.code === 'not_found'
    );
  });

  await t.test('6. Content bounds, tombstones, and locking', async () => {
    await repo.clear();
    await repo.createTeam('t1', 'team-1', 'Team', '', 'public', alice, t0);
    await repo.joinTeam('t1', bob, t1);

    // Body bounds validation
    await assert.rejects(
      async () => repo.createThread('th1', 't1', alice, 'Title', '   ', 'p1', t0),
      (err: any) => err instanceof CommunityRuleError && err.code === 'invalid_input'
    );

    const { thread, post } = await repo.createThread('th1', 't1', alice, 'Title', 'First post', 'p1', t0);

    // Delete post => tombstone
    const deletedPost = await repo.deletePost(post.id, alice, t1);
    assert.equal(deletedPost.body, '');
    assert.ok(deletedPost.deletedAt);

    // Editing tombstoned post fails
    await assert.rejects(
      async () => repo.editPost(post.id, alice, 'Revive', t2),
      (err: any) => err instanceof CommunityRuleError && err.code === 'invalid_transition'
    );

    // Lock thread by admin/owner
    await repo.updateThread(thread.id, alice, { locked: true }, t1);

    // Member bob cannot post in locked thread
    await assert.rejects(
      async () => repo.createPost('p2', thread.id, bob, 'In locked thread', t2),
      (err: any) => err instanceof CommunityRuleError && err.code === 'not_authorized'
    );

    // Owner alice CAN post in locked thread
    const postByOwner = await repo.createPost('p2', thread.id, alice, 'Owner post in locked thread', t2);
    assert.equal(postByOwner.body, 'Owner post in locked thread');
  });

  await t.test('7. Moderation vs Forgery (admins delete, only authors edit)', async () => {
    await repo.clear();
    await repo.createTeam('t1', 'team-1', 'Team', '', 'public', alice, t0); // owner
    await repo.joinTeam('t1', bob, t1); // member

    const { thread, post } = await repo.createThread('th1', 't1', bob, 'Bob Thread', 'Bob original words', 'p1', t0);

    // Owner Alice CANNOT edit Bob's post (forgery prevention)
    await assert.rejects(
      async () => repo.editPost(post.id, alice, 'Alice tampered body', t1),
      (err: any) => err instanceof CommunityRuleError && err.code === 'not_authorized'
    );

    // Owner Alice CAN delete Bob's post (moderation)
    const moderated = await repo.deletePost(post.id, alice, t1);
    assert.equal(moderated.body, '');
    assert.ok(moderated.deletedAt);
  });

  await t.test('8. Ordering and pagination invariants', async () => {
    await repo.clear();
    await repo.createTeam('t1', 'team-1', 'Team', '', 'public', alice, t0);
    await repo.joinTeam('t1', bob, t1);
    await repo.joinTeam('t1', charlie, t1);

    // Create 3 threads: th1 (unpinned, t0), th2 (unpinned, t2), th3 (pinned, t1)
    await repo.createThread('th1', 't1', alice, 'Thread 1', 'P1', 'p1', t0);
    await repo.createThread('th2', 't1', alice, 'Thread 2', 'P2', 'p2', t2);
    const { thread: th3 } = await repo.createThread('th3', 't1', alice, 'Thread 3', 'P3', 'p3', t1);
    await repo.updateThread(th3.id, alice, { pinned: true }, t2);

    const threadsPage = await repo.listThreads('t1', alice, { limit: 10 });
    assert.equal(threadsPage.total, 3);
    // Pinned th3 should come first, then th2 (t2 recency), then th1 (t0 recency)
    assert.equal(threadsPage.items[0].id, 'th3');
    assert.equal(threadsPage.items[1].id, 'th2');
    assert.equal(threadsPage.items[2].id, 'th1');

    // NaN limit/offset handling
    const nanPage = await repo.listThreads('t1', alice, { limit: NaN, offset: NaN });
    assert.equal(nanPage.total, 3);
    assert.equal(nanPage.items.length, 0); // limit NaN => 0 items
  });

  await t.test('9. listJoinRequests status filtering before pagination', async () => {
    await repo.clear();
    await repo.createTeam('t1', 'team-1', 'Team 1', '', 'public', alice, t0);
    // Create requests: r1 (accepted, t0), r2 (accepted, t1), r3 (pending, t2)
    await repo.createJoinRequest('req-1', 't1', bob, t0);
    await repo.respondToJoinRequest('req-1', alice, 'accepted', t1);
    await repo.createJoinRequest('req-2', 't1', charlie, t1);
    await repo.respondToJoinRequest('req-2', alice, 'accepted', t2);
    await repo.createJoinRequest('req-3', 't1', dave, t2);

    // Omitting status returns all 3 requests
    const allReqs = await repo.listJoinRequests('t1', alice);
    assert.equal(allReqs.total, 3);
    assert.equal(allReqs.items.length, 3);

    // Filtering by status 'pending' before pagination:
    // Total matching pending requests is 1 (r3).
    const pendingPage = await repo.listJoinRequests('t1', alice, { status: 'pending', limit: 1, offset: 0 });
    assert.equal(pendingPage.total, 1);
    assert.equal(pendingPage.items.length, 1);
    assert.equal(pendingPage.items[0].id, 'req-3');

    // Page offset 1 returns 0 items because total matching pending requests is 1
    const emptyPage = await repo.listJoinRequests('t1', alice, { status: 'pending', limit: 1, offset: 1 });
    assert.equal(emptyPage.total, 1);
    assert.equal(emptyPage.items.length, 0);
  });
});
