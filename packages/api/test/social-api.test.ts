import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers';

test('Social API: 503 when social graph repository is not configured', async () => {
  const harness = await startHarness({}, { withoutSocial: true });
  try {
    const user = await harness.makeUser('alice');
    const res = await harness.json('POST', `/v1/social/follows/${user.userId}`, { token: user.token });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.message, 'social graph repository is not configured');
  } finally {
    await harness.close();
  }
});

test('Social API: authentication enforcement on protected endpoints', async () => {
  const harness = await startHarness();
  try {
    const fakeUuid = '01918300-0000-7000-8000-000000000001';
    
    // Protected endpoints without token return 401
    const res1 = await harness.json('POST', `/v1/social/follows/${fakeUuid}`);
    assert.equal(res1.status, 401);

    const res2 = await harness.json('DELETE', `/v1/social/follows/${fakeUuid}`);
    assert.equal(res2.status, 401);

    const res3 = await harness.json('POST', '/v1/social/friend-requests', { body: { addresseeId: fakeUuid } });
    assert.equal(res3.status, 401);

    const res4 = await harness.json('POST', `/v1/social/friend-requests/${fakeUuid}/respond`, { body: { action: 'accept' } });
    assert.equal(res4.status, 401);

    const res5 = await harness.json('GET', '/v1/social/friend-requests/incoming');
    assert.equal(res5.status, 401);

    const res6 = await harness.json('GET', '/v1/social/friend-requests/outgoing');
    assert.equal(res6.status, 401);

    const res7 = await harness.json('GET', '/v1/social/friends');
    assert.equal(res7.status, 401);

    const res8 = await harness.json('POST', `/v1/social/blocks/${fakeUuid}`);
    assert.equal(res8.status, 401);

    const res9 = await harness.json('DELETE', `/v1/social/blocks/${fakeUuid}`);
    assert.equal(res9.status, 401);

    const res10 = await harness.json('GET', '/v1/social/blocks');
    assert.equal(res10.status, 401);

    // Public endpoints allow unauthenticated access
    const resPublicFollowers = await harness.json('GET', `/v1/social/players/${fakeUuid}/followers`);
    assert.equal(resPublicFollowers.status, 200);

    const resPublicFollowing = await harness.json('GET', `/v1/social/players/${fakeUuid}/following`);
    assert.equal(resPublicFollowing.status, 200);
  } finally {
    await harness.close();
  }
});

test('Social API: full round-trip follow, friend request lifecycle, blocks, and lists', async () => {
  const harness = await startHarness();
  try {
    const alice = await harness.makeUser('alice');
    const bob = await harness.makeUser('bob');
    const charlie = await harness.makeUser('charlie');

    // 1. Follow & Unfollow
    const followRes = await harness.json('POST', `/v1/social/follows/${bob.userId}`, { token: alice.token });
    assert.equal(followRes.status, 200);
    assert.equal(followRes.body.followerId, alice.userId);
    assert.equal(followRes.body.followeeId, bob.userId);

    const followingRes = await harness.json('GET', `/v1/social/players/${alice.userId}/following`);
    assert.equal(followingRes.status, 200);
    assert.equal(followingRes.body.total, 1);
    assert.equal(followingRes.body.items[0].followeeId, bob.userId);

    const followersRes = await harness.json('GET', `/v1/social/players/${bob.userId}/followers`);
    assert.equal(followersRes.status, 200);
    assert.equal(followersRes.body.total, 1);
    assert.equal(followersRes.body.items[0].followerId, alice.userId);

    const unfollowRes = await harness.json('DELETE', `/v1/social/follows/${bob.userId}`, { token: alice.token });
    assert.equal(unfollowRes.status, 204);

    const followingAfter = await harness.json('GET', `/v1/social/players/${alice.userId}/following`);
    assert.equal(followingAfter.body.total, 0);

    // 2. Friend Requests Lifecycle
    // Send friend request Alice -> Bob
    const reqRes = await harness.json('POST', '/v1/social/friend-requests', {
      token: alice.token,
      body: { addresseeId: bob.userId },
    });
    assert.equal(reqRes.status, 201);
    assert.equal(reqRes.body.requesterId, alice.userId);
    assert.equal(reqRes.body.addresseeId, bob.userId);
    assert.equal(reqRes.body.status, 'pending');
    const reqId = reqRes.body.id;

    // Check outgoing for Alice, incoming for Bob
    const outgoingRes = await harness.json('GET', '/v1/social/friend-requests/outgoing', { token: alice.token });
    assert.equal(outgoingRes.status, 200);
    assert.equal(outgoingRes.body.total, 1);
    assert.equal(outgoingRes.body.items[0].id, reqId);

    const incomingRes = await harness.json('GET', '/v1/social/friend-requests/incoming', { token: bob.token });
    assert.equal(incomingRes.status, 200);
    assert.equal(incomingRes.body.total, 1);
    assert.equal(incomingRes.body.items[0].id, reqId);

    // Duplicate request -> 409 Conflict
    const dupRes = await harness.json('POST', '/v1/social/friend-requests', {
      token: alice.token,
      body: { addresseeId: bob.userId },
    });
    assert.equal(dupRes.status, 409);

    // Bob accepts friend request
    const acceptRes = await harness.json('POST', `/v1/social/friend-requests/${reqId}/respond`, {
      token: bob.token,
      body: { action: 'accept' },
    });
    assert.equal(acceptRes.status, 200);
    assert.equal(acceptRes.body.status, 'accepted');

    // Alice and Bob check friends list
    const aliceFriends = await harness.json('GET', '/v1/social/friends', { token: alice.token });
    assert.equal(aliceFriends.status, 200);
    assert.equal(aliceFriends.body.total, 1);
    assert.equal(aliceFriends.body.items[0], bob.userId);

    const bobFriends = await harness.json('GET', '/v1/social/friends', { token: bob.token });
    assert.equal(bobFriends.status, 200);
    assert.equal(bobFriends.body.total, 1);
    assert.equal(bobFriends.body.items[0], alice.userId);

    // 3. Blocks Lifecycle & Invariants
    // Alice blocks Bob (should terminate friendship)
    const blockRes = await harness.json('POST', `/v1/social/blocks/${bob.userId}`, { token: alice.token });
    assert.equal(blockRes.status, 200);
    assert.equal(blockRes.body.blockerId, alice.userId);
    assert.equal(blockRes.body.blockedId, bob.userId);

    // Alice's friends list is now empty
    const aliceFriendsPostBlock = await harness.json('GET', '/v1/social/friends', { token: alice.token });
    assert.equal(aliceFriendsPostBlock.body.total, 0);

    // Alice lists blocks
    const blocksList = await harness.json('GET', '/v1/social/blocks', { token: alice.token });
    assert.equal(blocksList.status, 200);
    assert.equal(blocksList.body.total, 1);
    assert.equal(blocksList.body.items[0].blockedId, bob.userId);

    // Bob tries to follow Alice while blocked -> 403 Forbidden
    const followBlocked = await harness.json('POST', `/v1/social/follows/${alice.userId}`, { token: bob.token });
    assert.equal(followBlocked.status, 403);

    // Alice tries to send friend request to Bob while blocked -> 403 Forbidden
    const reqBlocked = await harness.json('POST', '/v1/social/friend-requests', {
      token: alice.token,
      body: { addresseeId: bob.userId },
    });
    assert.equal(reqBlocked.status, 403);

    // Self relation attempts -> 422 Validation
    const selfFollow = await harness.json('POST', `/v1/social/follows/${alice.userId}`, { token: alice.token });
    assert.equal(selfFollow.status, 422);

    const selfFriendReq = await harness.json('POST', '/v1/social/friend-requests', {
      token: alice.token,
      body: { addresseeId: alice.userId },
    });
    assert.equal(selfFriendReq.status, 422);

    const selfBlock = await harness.json('POST', `/v1/social/blocks/${alice.userId}`, { token: alice.token });
    assert.equal(selfBlock.status, 422);

    // Unblock Bob
    const unblockRes = await harness.json('DELETE', `/v1/social/blocks/${bob.userId}`, { token: alice.token });
    assert.equal(unblockRes.status, 204);

    const blocksAfter = await harness.json('GET', '/v1/social/blocks', { token: alice.token });
    assert.equal(blocksAfter.body.total, 0);
  } finally {
    await harness.close();
  }
});
