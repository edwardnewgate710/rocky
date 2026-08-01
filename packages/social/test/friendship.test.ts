import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FriendRequest, FriendRequestAction } from '../src/friendship';
import {
  applyFriendRequestAction,
  areFriends,
  friendsOf,
  involvesPair,
  pendingIncoming,
  pendingOutgoing,
  terminateFriendship,
} from '../src/friendship';
import { SocialRuleError } from '../src/errors';

describe('friendship pure domain functions', () => {
  const t1 = new Date('2026-01-01T10:00:00Z');
  const t2 = new Date('2026-01-02T10:00:00Z');
  const t3 = new Date('2026-01-03T10:00:00Z');

  const pendingReq: FriendRequest = {
    id: 'req_1',
    requesterId: 'alice',
    addresseeId: 'bob',
    status: 'pending',
    createdAt: t1,
  };

  describe('applyFriendRequestAction', () => {
    it('accepts a pending request when actor is addressee', () => {
      const updated = applyFriendRequestAction(pendingReq, 'accept', 'bob', t2);
      assert.equal(updated.id, 'req_1');
      assert.equal(updated.status, 'accepted');
      assert.equal(updated.respondedAt, t2);
      assert.equal(pendingReq.status, 'pending'); // immutability check
    });

    it('declines a pending request when actor is addressee', () => {
      const updated = applyFriendRequestAction(pendingReq, 'decline', 'bob', t2);
      assert.equal(updated.status, 'declined');
      assert.equal(updated.respondedAt, t2);
    });

    it('cancels a pending request when actor is requester', () => {
      const updated = applyFriendRequestAction(pendingReq, 'cancel', 'alice', t2);
      assert.equal(updated.status, 'cancelled');
      assert.equal(updated.respondedAt, t2);
    });

    it('throws invalid_transition when acting on accepted request', () => {
      const accepted: FriendRequest = { ...pendingReq, status: 'accepted', respondedAt: t2 };
      assert.throws(
        () => applyFriendRequestAction(accepted, 'accept', 'bob', t3),
        (err: unknown) => err instanceof SocialRuleError && err.code === 'invalid_transition'
      );
    });

    it('throws invalid_transition when acting on declined request', () => {
      const declined: FriendRequest = { ...pendingReq, status: 'declined', respondedAt: t2 };
      assert.throws(
        () => applyFriendRequestAction(declined, 'accept', 'bob', t3),
        (err: unknown) => err instanceof SocialRuleError && err.code === 'invalid_transition'
      );
    });

    it('throws invalid_transition when acting on cancelled request', () => {
      const cancelled: FriendRequest = { ...pendingReq, status: 'cancelled', respondedAt: t2 };
      assert.throws(
        () => applyFriendRequestAction(cancelled, 'accept', 'bob', t3),
        (err: unknown) => err instanceof SocialRuleError && err.code === 'invalid_transition'
      );
    });

    it('throws not_authorized when requester tries to accept', () => {
      assert.throws(
        () => applyFriendRequestAction(pendingReq, 'accept', 'alice', t2),
        (err: unknown) => err instanceof SocialRuleError && err.code === 'not_authorized'
      );
    });

    it('throws not_authorized when requester tries to decline', () => {
      assert.throws(
        () => applyFriendRequestAction(pendingReq, 'decline', 'alice', t2),
        (err: unknown) => err instanceof SocialRuleError && err.code === 'not_authorized'
      );
    });

    it('throws not_authorized when addressee tries to cancel', () => {
      assert.throws(
        () => applyFriendRequestAction(pendingReq, 'cancel', 'bob', t2),
        (err: unknown) => err instanceof SocialRuleError && err.code === 'not_authorized'
      );
    });

    it('throws not_authorized when third party tries any action', () => {
      assert.throws(
        () => applyFriendRequestAction(pendingReq, 'accept', 'charlie', t2),
        (err: unknown) => err instanceof SocialRuleError && err.code === 'not_authorized'
      );
    });
  });

  describe('areFriends', () => {
    const requests: readonly FriendRequest[] = [
      {
        id: 'r1',
        requesterId: 'alice',
        addresseeId: 'bob',
        status: 'accepted',
        createdAt: t1,
        respondedAt: t2,
      },
      { id: 'r2', requesterId: 'charlie', addresseeId: 'alice', status: 'pending', createdAt: t1 },
      {
        id: 'r3',
        requesterId: 'david',
        addresseeId: 'alice',
        status: 'declined',
        createdAt: t1,
        respondedAt: t2,
      },
    ];

    it('returns true when an accepted request exists (requester -> addressee)', () => {
      assert.equal(areFriends('alice', 'bob', requests), true);
    });

    it('returns true when asked in reverse order (symmetry test)', () => {
      assert.equal(areFriends('bob', 'alice', requests), true);
    });

    it('returns false for pending or declined requests', () => {
      assert.equal(areFriends('charlie', 'alice', requests), false);
      assert.equal(areFriends('david', 'alice', requests), false);
    });

    it('returns false for self pair', () => {
      assert.equal(areFriends('alice', 'alice', requests), false);
    });
  });

  describe('friendsOf', () => {
    const requests: readonly FriendRequest[] = [
      {
        id: 'r1',
        requesterId: 'alice',
        addresseeId: 'bob',
        status: 'accepted',
        createdAt: t1,
        respondedAt: t1,
      },
      {
        id: 'r2',
        requesterId: 'charlie',
        addresseeId: 'alice',
        status: 'accepted',
        createdAt: t1,
        respondedAt: t3,
      },
      {
        id: 'r3',
        requesterId: 'david',
        addresseeId: 'alice',
        status: 'accepted',
        createdAt: t1,
        respondedAt: t3,
      },
      { id: 'r4', requesterId: 'eve', addresseeId: 'alice', status: 'pending', createdAt: t1 },
    ];

    it('returns counterpart IDs ordered newest-accepted first, tie-broken by counterpart ID ASC', () => {
      const friends = friendsOf('alice', requests);
      assert.equal(friends.length, 3);
      // charlie and david accepted at t3 (charlie < david), bob accepted at t1
      assert.equal(friends[0], 'charlie');
      assert.equal(friends[1], 'david');
      assert.equal(friends[2], 'bob');
    });

    it('returns empty array when player has no accepted friends', () => {
      assert.deepEqual(friendsOf('eve', requests), []);
    });
  });

  describe('pendingIncoming and pendingOutgoing', () => {
    const requests: readonly FriendRequest[] = [
      { id: 'r1', requesterId: 'bob', addresseeId: 'alice', status: 'pending', createdAt: t1 },
      { id: 'r2', requesterId: 'charlie', addresseeId: 'alice', status: 'pending', createdAt: t3 },
      { id: 'r3', requesterId: 'david', addresseeId: 'alice', status: 'pending', createdAt: t3 },
      { id: 'r4', requesterId: 'alice', addresseeId: 'eve', status: 'pending', createdAt: t2 },
    ];

    it('pendingIncoming returns pending incoming requests ordered newest first + requester ASC', () => {
      const incoming = pendingIncoming('alice', requests);
      assert.equal(incoming.length, 3);
      // charlie and david at t3 (charlie < david), bob at t1
      assert.equal(incoming[0].requesterId, 'charlie');
      assert.equal(incoming[1].requesterId, 'david');
      assert.equal(incoming[2].requesterId, 'bob');
    });

    it('pendingOutgoing returns pending outgoing requests', () => {
      const outgoing = pendingOutgoing('alice', requests);
      assert.equal(outgoing.length, 1);
      assert.equal(outgoing[0].addresseeId, 'eve');
    });
  });

  describe('applyFriendRequestAction with an action the type system excludes', () => {
    // Increment 2 puts this value in a REST request body. A cast, a JavaScript caller or a
    // deserialized payload all cross the type boundary unchecked, and the previous
    // if/else-if + ternary structure both skipped the authority check and fell through to
    // 'cancelled' — letting a non-requester cancel someone else's pending request.
    const pending: FriendRequest = {
      id: 'req_1',
      requesterId: 'alice',
      addresseeId: 'bob',
      status: 'pending',
      createdAt: t1,
    };

    for (const bogus of ['bogus', '', 'ACCEPT', 'constructor', '__proto__', 'toString']) {
      it(`rejects '${bogus}' instead of treating it as a cancellation`, () => {
        assert.throws(
          () =>
            applyFriendRequestAction(
              pending,
              bogus as unknown as FriendRequestAction,
              'carol',
              t2
            ),
          (err: unknown) =>
            err instanceof SocialRuleError && err.code === 'invalid_transition'
        );
      });
    }

    it('leaves the request untouched when the action is rejected', () => {
      assert.throws(() =>
        applyFriendRequestAction(pending, 'bogus' as unknown as FriendRequestAction, 'carol', t2)
      );
      assert.equal(pending.status, 'pending');
      assert.equal(pending.respondedAt, undefined);
    });
  });

  describe('involvesPair', () => {
    const req: FriendRequest = {
      id: 'r',
      requesterId: 'alice',
      addresseeId: 'bob',
      status: 'pending',
      createdAt: t1,
    };

    it('matches the pair asked in either order', () => {
      assert.equal(involvesPair(req, 'alice', 'bob'), true);
      assert.equal(involvesPair(req, 'bob', 'alice'), true);
    });

    it('does not match when only one player is involved', () => {
      assert.equal(involvesPair(req, 'alice', 'carol'), false);
      assert.equal(involvesPair(req, 'carol', 'bob'), false);
    });

    it('does not match an unrelated pair', () => {
      assert.equal(involvesPair(req, 'carol', 'dave'), false);
    });

    it('ignores status — it is a question about the participants only', () => {
      assert.equal(involvesPair({ ...req, status: 'ended' }, 'bob', 'alice'), true);
    });
  });

  describe('terminateFriendship', () => {
    const accepted: FriendRequest = {
      id: 'req_1',
      requesterId: 'alice',
      addresseeId: 'bob',
      status: 'accepted',
      createdAt: t1,
      respondedAt: t2,
    };

    it('moves an accepted friendship to ended and stamps respondedAt', () => {
      const ended = terminateFriendship(accepted, t3);
      assert.equal(ended.status, 'ended');
      assert.equal(ended.respondedAt, t3);
    });

    it('does not mutate the input', () => {
      terminateFriendship(accepted, t3);
      assert.equal(accepted.status, 'accepted');
      assert.equal(accepted.respondedAt, t2);
    });

    it('leaves the pair intact so the audit trail still names both parties', () => {
      const ended = terminateFriendship(accepted, t3);
      assert.equal(ended.requesterId, 'alice');
      assert.equal(ended.addresseeId, 'bob');
      assert.equal(ended.createdAt, t1);
    });

    it('rejects every status other than accepted', () => {
      for (const status of ['pending', 'declined', 'cancelled', 'ended'] as const) {
        assert.throws(
          () => terminateFriendship({ ...accepted, status }, t3),
          (err: unknown) =>
            err instanceof SocialRuleError && err.code === 'invalid_transition',
          `expected '${status}' to be rejected`
        );
      }
    });

    it('is not reachable through applyFriendRequestAction, which treats accepted as terminal', () => {
      for (const action of ['accept', 'decline', 'cancel'] as const) {
        assert.throws(
          () => applyFriendRequestAction(accepted, action, 'bob', t3),
          (err: unknown) =>
            err instanceof SocialRuleError && err.code === 'invalid_transition'
        );
      }
    });

    it('leaves an ended friendship out of areFriends', () => {
      const ended = terminateFriendship(accepted, t3);
      assert.equal(areFriends('alice', 'bob', [ended]), false);
      assert.equal(friendsOf('alice', [ended]).length, 0);
    });
  });
});
