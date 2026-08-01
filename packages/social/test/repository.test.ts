import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySocialGraphRepository } from '../src/repository';
import { SocialRuleError } from '../src/errors';

describe('InMemorySocialGraphRepository', () => {
  let repo: InMemorySocialGraphRepository;

  const t1 = new Date('2026-01-01T10:00:00Z');
  const t2 = new Date('2026-01-02T10:00:00Z');
  const t3 = new Date('2026-01-03T10:00:00Z');
  const t4 = new Date('2026-01-04T10:00:00Z');

  beforeEach(async () => {
    repo = new InMemorySocialGraphRepository();
    await repo.clear();
  });

  describe('Follow operations', () => {
    it('allows a player to follow another player', async () => {
      const edge = await repo.follow('alice', 'bob', t1);
      assert.equal(edge.followerId, 'alice');
      assert.equal(edge.followeeId, 'bob');
      assert.equal(edge.followedAt, t1);
      assert.equal(await repo.isFollowing('alice', 'bob'), true);
    });

    it('follow is idempotent and preserves original followedAt timestamp', async () => {
      const edge1 = await repo.follow('alice', 'bob', t1);
      const edge2 = await repo.follow('alice', 'bob', t2); // attempted repeat follow at t2
      assert.equal(edge2.followedAt, t1); // original timestamp retained
      assert.deepEqual(edge1, edge2);

      const followingPage = await repo.listFollowing('alice');
      assert.equal(followingPage.total, 1);
    });

    it('throws self_relation when followerId === followeeId', async () => {
      await assert.rejects(
        () => repo.follow('alice', 'alice', t1),
        (err: unknown) => err instanceof SocialRuleError && err.code === 'self_relation'
      );
    });

    it('unfollow removes existing follow edge and returns true', async () => {
      await repo.follow('alice', 'bob', t1);
      assert.equal(await repo.isFollowing('alice', 'bob'), true);

      const removed = await repo.unfollow('alice', 'bob');
      assert.equal(removed, true);
      assert.equal(await repo.isFollowing('alice', 'bob'), false);
    });

    it('unfollow returns false when follow edge did not exist', async () => {
      const removed = await repo.unfollow('alice', 'bob');
      assert.equal(removed, false);
    });

    it('unfollow throws self_relation when followerId === followeeId', async () => {
      await assert.rejects(
        () => repo.unfollow('alice', 'alice'),
        (err: unknown) => err instanceof SocialRuleError && err.code === 'self_relation'
      );
    });

    it('listFollowers and listFollowing return paginated results', async () => {
      await repo.follow('bob', 'alice', t1);
      await repo.follow('charlie', 'alice', t2);
      await repo.follow('alice', 'david', t3);

      const followersPage = await repo.listFollowers('alice', { limit: 1 });
      assert.equal(followersPage.total, 2);
      assert.equal(followersPage.items.length, 1);
      assert.equal(followersPage.items[0].followerId, 'charlie'); // newest first

      const followingPage = await repo.listFollowing('alice');
      assert.equal(followingPage.total, 1);
      assert.equal(followingPage.items[0].followeeId, 'david');
    });
  });

  describe('Friend request operations', () => {
    it('sends a friend request successfully', async () => {
      const req = await repo.sendFriendRequest('req1', 'alice', 'bob', t1);
      assert.equal(req.id, 'req1');
      assert.equal(req.requesterId, 'alice');
      assert.equal(req.addresseeId, 'bob');
      assert.equal(req.status, 'pending');
      assert.equal(req.createdAt, t1);
    });

    it('throws self_relation when requesterId === addresseeId', async () => {
      await assert.rejects(
        () => repo.sendFriendRequest('req1', 'alice', 'alice', t1),
        (err: unknown) => err instanceof SocialRuleError && err.code === 'self_relation'
      );
    });

    it('throws already_exists when request ID is already taken', async () => {
      await repo.sendFriendRequest('req1', 'alice', 'bob', t1);
      await assert.rejects(
        () => repo.sendFriendRequest('req1', 'charlie', 'david', t2),
        (err: unknown) => err instanceof SocialRuleError && err.code === 'already_exists'
      );
    });

    it('throws already_exists when pending request already exists in same direction', async () => {
      await repo.sendFriendRequest('req1', 'alice', 'bob', t1);
      await assert.rejects(
        () => repo.sendFriendRequest('req2', 'alice', 'bob', t2),
        (err: unknown) => err instanceof SocialRuleError && err.code === 'already_exists'
      );
    });

    it('throws already_exists when pending request already exists in opposite direction (crossing request)', async () => {
      await repo.sendFriendRequest('req1', 'alice', 'bob', t1);
      await assert.rejects(
        () => repo.sendFriendRequest('req2', 'bob', 'alice', t2),
        (err: unknown) => err instanceof SocialRuleError && err.code === 'already_exists'
      );
    });

    it('throws already_exists when players are already friends', async () => {
      await repo.sendFriendRequest('req1', 'alice', 'bob', t1);
      await repo.respondToFriendRequest('req1', 'accept', 'bob', t2);
      assert.equal(await repo.areFriends('alice', 'bob'), true);

      await assert.rejects(
        () => repo.sendFriendRequest('req2', 'alice', 'bob', t3),
        (err: unknown) => err instanceof SocialRuleError && err.code === 'already_exists'
      );
    });

    it('allows new friend request if prior request was declined or cancelled', async () => {
      await repo.sendFriendRequest('req1', 'alice', 'bob', t1);
      await repo.respondToFriendRequest('req1', 'decline', 'bob', t2);

      const req2 = await repo.sendFriendRequest('req2', 'alice', 'bob', t3);
      assert.equal(req2.id, 'req2');
      assert.equal(req2.status, 'pending');
    });

    it('findFriendRequest returns request or undefined', async () => {
      await repo.sendFriendRequest('req1', 'alice', 'bob', t1);
      const found = await repo.findFriendRequest('req1');
      assert.ok(found);
      assert.equal(found.id, 'req1');

      const notFound = await repo.findFriendRequest('nonexistent');
      assert.equal(notFound, undefined);
    });

    it('respondToFriendRequest updates status and respondedAt', async () => {
      await repo.sendFriendRequest('req1', 'alice', 'bob', t1);
      const accepted = await repo.respondToFriendRequest('req1', 'accept', 'bob', t2);
      assert.equal(accepted.status, 'accepted');
      assert.equal(accepted.respondedAt, t2);
      assert.equal(await repo.areFriends('alice', 'bob'), true);
    });

    // The repository must route responses through the state machine rather than writing statuses
    // itself. Testing the authority rules only on `applyFriendRequestAction` would leave a
    // repository that bypassed it entirely passing every test.
    it('respondToFriendRequest refuses a response from the wrong party', async () => {
      await repo.sendFriendRequest('req1', 'alice', 'bob', t1);

      for (const [action, wrongActor] of [
        ['accept', 'alice'],
        ['decline', 'alice'],
        ['cancel', 'bob'],
      ] as const) {
        await assert.rejects(
          () => repo.respondToFriendRequest('req1', action, wrongActor, t2),
          (err: unknown) =>
            err instanceof SocialRuleError && err.code === 'not_authorized',
          `${wrongActor} must not be able to ${action}`
        );
      }

      const untouched = await repo.findFriendRequest('req1');
      assert.equal(untouched?.status, 'pending');
    });

    it('respondToFriendRequest refuses to act on an already-resolved request', async () => {
      await repo.sendFriendRequest('req1', 'alice', 'bob', t1);
      await repo.respondToFriendRequest('req1', 'accept', 'bob', t2);

      await assert.rejects(
        () => repo.respondToFriendRequest('req1', 'decline', 'bob', t3),
        (err: unknown) =>
          err instanceof SocialRuleError && err.code === 'invalid_transition'
      );

      const stillAccepted = await repo.findFriendRequest('req1');
      assert.equal(stillAccepted?.status, 'accepted');
      assert.equal(stillAccepted?.respondedAt, t2, 'respondedAt must not be overwritten');
    });

    it('respondToFriendRequest throws not_found for unknown request ID', async () => {
      await assert.rejects(
        () => repo.respondToFriendRequest('unknown', 'accept', 'bob', t1),
        (err: unknown) => err instanceof SocialRuleError && err.code === 'not_found'
      );
    });

    it('listIncomingRequests and listOutgoingRequests work correctly', async () => {
      await repo.sendFriendRequest('req1', 'alice', 'bob', t1);
      await repo.sendFriendRequest('req2', 'charlie', 'bob', t2);

      const incoming = await repo.listIncomingRequests('bob');
      assert.equal(incoming.total, 2);
      assert.equal(incoming.items[0].requesterId, 'charlie'); // newest first

      const outgoing = await repo.listOutgoingRequests('alice');
      assert.equal(outgoing.total, 1);
      assert.equal(outgoing.items[0].addresseeId, 'bob');
    });

    it('listFriends returns paginated counterpart player IDs', async () => {
      await repo.sendFriendRequest('req1', 'alice', 'bob', t1);
      await repo.respondToFriendRequest('req1', 'accept', 'bob', t2);
      await repo.sendFriendRequest('req2', 'charlie', 'alice', t1);
      await repo.respondToFriendRequest('req2', 'accept', 'alice', t3);

      const friendsPage = await repo.listFriends('alice');
      assert.equal(friendsPage.total, 2);
      assert.equal(friendsPage.items[0], 'charlie'); // accepted at t3
      assert.equal(friendsPage.items[1], 'bob'); // accepted at t2
    });

    it('areFriends exhibits symmetry (true regardless of parameter order)', async () => {
      await repo.sendFriendRequest('req1', 'alice', 'bob', t1);
      await repo.respondToFriendRequest('req1', 'accept', 'bob', t2);

      assert.equal(await repo.areFriends('alice', 'bob'), true);
      assert.equal(await repo.areFriends('bob', 'alice'), true);
    });
  });

  describe('Block operations', () => {
    it('creates a block edge successfully', async () => {
      const blockEdge = await repo.block('alice', 'bob', t1);
      assert.equal(blockEdge.blockerId, 'alice');
      assert.equal(blockEdge.blockedId, 'bob');
      assert.equal(blockEdge.blockedAt, t1);
      assert.equal(await repo.isBlockedBetween('alice', 'bob'), true);
    });

    it('throws self_relation when blockerId === blockedId', async () => {
      await assert.rejects(
        () => repo.block('alice', 'alice', t1),
        (err: unknown) => err instanceof SocialRuleError && err.code === 'self_relation'
      );
    });

    it('unblock removes block edge and returns true', async () => {
      await repo.block('alice', 'bob', t1);
      assert.equal(await repo.isBlockedBetween('alice', 'bob'), true);

      const unblocked = await repo.unblock('alice', 'bob');
      assert.equal(unblocked, true);
      assert.equal(await repo.isBlockedBetween('alice', 'bob'), false);
    });

    it('unblock returns false when block edge did not exist', async () => {
      const unblocked = await repo.unblock('alice', 'bob');
      assert.equal(unblocked, false);
    });

    it('unblock throws self_relation when blockerId === blockedId', async () => {
      await assert.rejects(
        () => repo.unblock('alice', 'alice'),
        (err: unknown) => err instanceof SocialRuleError && err.code === 'self_relation'
      );
    });

    it('listBlocked returns paginated blocks for player', async () => {
      await repo.block('alice', 'bob', t1);
      await repo.block('alice', 'charlie', t2);

      const blockedPage = await repo.listBlocked('alice');
      assert.equal(blockedPage.total, 2);
      assert.equal(blockedPage.items[0].blockedId, 'charlie'); // newest first
      assert.equal(blockedPage.items[1].blockedId, 'bob');
    });

    it('isBlockedBetween returns true for both blocker and blocked', async () => {
      await repo.block('alice', 'bob', t1);
      assert.equal(await repo.isBlockedBetween('alice', 'bob'), true);
      assert.equal(await repo.isBlockedBetween('bob', 'alice'), true);
    });
  });

  describe('Precedence rules — block tears down all existing relations', () => {
    it('block tears down outbound follow (A -> B)', async () => {
      await repo.follow('alice', 'bob', t1);
      assert.equal(await repo.isFollowing('alice', 'bob'), true);

      await repo.block('alice', 'bob', t2);
      assert.equal(await repo.isFollowing('alice', 'bob'), false);
    });

    it('block tears down inbound follow (B -> A)', async () => {
      await repo.follow('bob', 'alice', t1);
      assert.equal(await repo.isFollowing('bob', 'alice'), true);

      await repo.block('alice', 'bob', t2);
      assert.equal(await repo.isFollowing('bob', 'alice'), false);
    });

    it('block cancels pending friend request where blocker is requester (A -> B)', async () => {
      await repo.sendFriendRequest('req1', 'alice', 'bob', t1);
      await repo.block('alice', 'bob', t2);

      const req = await repo.findFriendRequest('req1');
      assert.ok(req);
      assert.equal(req.status, 'cancelled');
      assert.equal(req.respondedAt, t2);

      const incoming = await repo.listIncomingRequests('bob');
      assert.equal(incoming.total, 0);
    });

    it('block declines pending friend request where blocker is addressee (B -> A)', async () => {
      await repo.sendFriendRequest('req1', 'bob', 'alice', t1);
      await repo.block('alice', 'bob', t2);

      const req = await repo.findFriendRequest('req1');
      assert.ok(req);
      assert.equal(req.status, 'declined');
      assert.equal(req.respondedAt, t2);

      const incoming = await repo.listIncomingRequests('alice');
      assert.equal(incoming.total, 0);
    });

    it('block ends an active friendship without deleting history', async () => {
      await repo.sendFriendRequest('req1', 'alice', 'bob', t1);
      await repo.respondToFriendRequest('req1', 'accept', 'bob', t2);
      assert.equal(await repo.areFriends('alice', 'bob'), true);

      await repo.block('alice', 'bob', t3);
      assert.equal(await repo.areFriends('alice', 'bob'), false);

      const req = await repo.findFriendRequest('req1');
      assert.ok(req);
      // 'ended', not 'declined': the addressee did accept, and the history must keep saying so.
      assert.equal(req.status, 'ended');
      assert.equal(req.respondedAt, t3);
    });

    it('lets the pair befriend again after unblock, because ended is not pending', async () => {
      await repo.sendFriendRequest('req1', 'alice', 'bob', t1);
      await repo.respondToFriendRequest('req1', 'accept', 'bob', t1);
      await repo.block('alice', 'bob', t2);
      await repo.unblock('alice', 'bob');

      // Reconciliation needs a fresh request; the ended one must not block it.
      await repo.sendFriendRequest('req2', 'bob', 'alice', t3);
      await repo.respondToFriendRequest('req2', 'accept', 'alice', t3);
      assert.equal(await repo.areFriends('alice', 'bob'), true);

      const friends = await repo.listFriends('alice');
      assert.deepEqual(friends.items, ['bob'], 'the ended request must not double-count bob');
    });

    it('records who ended a friendship distinctly from who declined a request', async () => {
      await repo.sendFriendRequest('friends', 'alice', 'bob', t1);
      await repo.respondToFriendRequest('friends', 'accept', 'bob', t1);
      await repo.sendFriendRequest('refused', 'alice', 'carol', t1);
      await repo.respondToFriendRequest('refused', 'decline', 'carol', t1);

      await repo.block('alice', 'bob', t3);

      const ended = await repo.findFriendRequest('friends');
      const refused = await repo.findFriendRequest('refused');
      assert.equal(ended?.status, 'ended');
      assert.equal(refused?.status, 'declined');
    });
  });

  describe('Block restriction enforcement', () => {
    it('prevents blocked player from following blocker', async () => {
      await repo.block('alice', 'bob', t1);
      await assert.rejects(
        () => repo.follow('bob', 'alice', t2),
        (err: unknown) => err instanceof SocialRuleError && err.code === 'blocked'
      );
    });

    it('prevents blocker from following blocked player (blocker has no privileged access)', async () => {
      await repo.block('alice', 'bob', t1);
      await assert.rejects(
        () => repo.follow('alice', 'bob', t2),
        (err: unknown) => err instanceof SocialRuleError && err.code === 'blocked'
      );
    });

    it('prevents blocked player from sending friend request to blocker', async () => {
      await repo.block('alice', 'bob', t1);
      await assert.rejects(
        () => repo.sendFriendRequest('req1', 'bob', 'alice', t2),
        (err: unknown) => err instanceof SocialRuleError && err.code === 'blocked'
      );
    });

    it('prevents blocker from sending friend request to blocked player', async () => {
      await repo.block('alice', 'bob', t1);
      await assert.rejects(
        () => repo.sendFriendRequest('req1', 'alice', 'bob', t2),
        (err: unknown) => err instanceof SocialRuleError && err.code === 'blocked'
      );
    });
  });

  describe('Unblock restoration invariant', () => {
    it('unblock removes block but restores neither follows nor friendships', async () => {
      await repo.follow('alice', 'bob', t1);
      await repo.sendFriendRequest('req1', 'alice', 'charlie', t1);
      await repo.respondToFriendRequest('req1', 'accept', 'charlie', t2);

      await repo.block('alice', 'bob', t3);
      await repo.block('alice', 'charlie', t3);

      // Unblock both players
      await repo.unblock('alice', 'bob');
      await repo.unblock('alice', 'charlie');

      // Verify block is gone
      assert.equal(await repo.isBlockedBetween('alice', 'bob'), false);
      assert.equal(await repo.isBlockedBetween('alice', 'charlie'), false);

      // Verify follow and friendship were NOT restored
      assert.equal(await repo.isFollowing('alice', 'bob'), false);
      assert.equal(await repo.areFriends('alice', 'charlie'), false);
    });
  });

  describe('Ordering determinism and pagination', () => {
    it('breaks tie deterministically when two edges have identical timestamps', async () => {
      // Both edges created at exact same timestamp t1
      await repo.follow('zulu', 'alice', t1);
      await repo.follow('alpha', 'alice', t1);

      const followersPage = await repo.listFollowers('alice');
      assert.equal(followersPage.total, 2);
      // alpha comes before zulu because alpha < zulu
      assert.equal(followersPage.items[0].followerId, 'alpha');
      assert.equal(followersPage.items[1].followerId, 'zulu');
    });

    it('paginates correctly with total unaffected by limit/offset', async () => {
      await repo.follow('p1', 'alice', t1);
      await repo.follow('p2', 'alice', t2);
      await repo.follow('p3', 'alice', t3);

      const page1 = await repo.listFollowers('alice', { limit: 1, offset: 0 });
      assert.equal(page1.total, 3);
      assert.equal(page1.items.length, 1);
      assert.equal(page1.items[0].followerId, 'p3'); // newest first

      const page2 = await repo.listFollowers('alice', { limit: 1, offset: 1 });
      assert.equal(page2.total, 3);
      assert.equal(page2.items[0].followerId, 'p2');

      const outOfRange = await repo.listFollowers('alice', { limit: 10, offset: 100 });
      assert.equal(outOfRange.total, 3);
      assert.equal(outOfRange.items.length, 0);
    });

    it('clamps negative limit and offset to 0', async () => {
      await repo.follow('p1', 'alice', t1);

      const page = await repo.listFollowers('alice', { limit: -5, offset: -2 });
      assert.equal(page.total, 1);
      assert.equal(page.items.length, 0);
    });
  });
});
