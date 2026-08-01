import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FollowEdge } from '../src/follow';
import {
  byCounterpart,
  followersOf,
  followingOf,
  isFollowing,
} from '../src/follow';

describe('follow pure domain functions', () => {
  const t1 = new Date('2026-01-01T10:00:00Z');
  const t2 = new Date('2026-01-02T10:00:00Z');
  const t3 = new Date('2026-01-03T10:00:00Z');

  const sampleEdges: readonly FollowEdge[] = [
    { followerId: 'alice', followeeId: 'bob', followedAt: t1 },
    { followerId: 'alice', followeeId: 'charlie', followedAt: t3 },
    { followerId: 'bob', followeeId: 'alice', followedAt: t2 },
    { followerId: 'david', followeeId: 'alice', followedAt: t3 },
    { followerId: 'eve', followeeId: 'alice', followedAt: t3 },
  ];

  describe('isFollowing', () => {
    it('returns true when edge exists', () => {
      assert.equal(isFollowing('alice', 'bob', sampleEdges), true);
      assert.equal(isFollowing('bob', 'alice', sampleEdges), true);
    });

    it('returns false when edge does not exist', () => {
      assert.equal(isFollowing('alice', 'david', sampleEdges), false);
      assert.equal(isFollowing('charlie', 'alice', sampleEdges), false);
    });

    it('returns false for empty edge list', () => {
      assert.equal(isFollowing('alice', 'bob', []), false);
    });
  });

  describe('followersOf', () => {
    it('returns followers of player ordered newest first', () => {
      const followers = followersOf('alice', sampleEdges);
      assert.equal(followers.length, 3);
      // t3 (david and eve) before t2 (bob)
      assert.equal(followers[2].followerId, 'bob');
    });

    it('breaks ties deterministically by counterpart ID ascending when timestamp is identical', () => {
      const followers = followersOf('alice', sampleEdges);
      // david and eve both have t3; david < eve
      assert.equal(followers[0].followerId, 'david');
      assert.equal(followers[1].followerId, 'eve');
    });

    it('returns empty array when player has no followers', () => {
      const followers = followersOf('zulu', sampleEdges);
      assert.deepEqual(followers, []);
    });
  });

  describe('followingOf', () => {
    it('returns players followed by alice, newest first', () => {
      const following = followingOf('alice', sampleEdges);
      assert.equal(following.length, 2);
      assert.equal(following[0].followeeId, 'charlie'); // t3
      assert.equal(following[1].followeeId, 'bob'); // t1
    });

    it('returns empty array when player follows no one', () => {
      const following = followingOf('zulu', sampleEdges);
      assert.deepEqual(following, []);
    });
  });

  describe('byCounterpart', () => {
    const byFollowee = byCounterpart((e: FollowEdge) => e.followeeId);

    it('sorts newest timestamp first', () => {
      const edgeOld: FollowEdge = { followerId: 'a', followeeId: 'b', followedAt: t1 };
      const edgeNew: FollowEdge = { followerId: 'a', followeeId: 'c', followedAt: t2 };
      assert.ok(byFollowee(edgeOld, edgeNew) > 0);
      assert.ok(byFollowee(edgeNew, edgeOld) < 0);
    });

    it('breaks ties using counterpart ID ascending', () => {
      const edge1: FollowEdge = { followerId: 'a', followeeId: 'zulu', followedAt: t1 };
      const edge2: FollowEdge = { followerId: 'a', followeeId: 'alpha', followedAt: t1 };
      // alpha < zulu, so edge2 comes before edge1 when sorting ascending by counterpart
      assert.ok(byFollowee(edge1, edge2) > 0);
      assert.ok(byFollowee(edge2, edge1) < 0);
    });

    it('reads the side of the edge the accessor selects, not a fixed one', () => {
      const byFollower = byCounterpart((e: FollowEdge) => e.followerId);
      const edge1: FollowEdge = { followerId: 'zulu', followeeId: 'alpha', followedAt: t1 };
      const edge2: FollowEdge = { followerId: 'alpha', followeeId: 'zulu', followedAt: t1 };
      // Same pair of ids on opposite sides: the two comparators must disagree.
      assert.ok(byFollower(edge1, edge2) > 0);
      assert.ok(byFollowee(edge1, edge2) < 0);
    });
  });

  describe('immutability', () => {
    it('does not mutate or reorder the input edge array', () => {
      // These functions sort, and `Array.prototype.sort` is in-place: they must sort a copy.
      const originalCopy = [...sampleEdges];
      followersOf('alice', sampleEdges);
      followingOf('alice', sampleEdges);
      assert.deepEqual(sampleEdges, originalCopy);
    });
  });
});
