import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BlockEdge } from '../src/block';
import { blocksBy, isBlockedBetween } from '../src/block';

describe('block pure domain functions', () => {
  const t1 = new Date('2026-01-01T10:00:00Z');
  const t2 = new Date('2026-01-02T10:00:00Z');

  const sampleBlocks: readonly BlockEdge[] = [
    { blockerId: 'alice', blockedId: 'bob', blockedAt: t1 },
    { blockerId: 'alice', blockedId: 'charlie', blockedAt: t2 },
    { blockerId: 'david', blockedId: 'alice', blockedAt: t2 },
  ];

  describe('isBlockedBetween', () => {
    it('returns true when A blocked B', () => {
      assert.equal(isBlockedBetween('alice', 'bob', sampleBlocks), true);
    });

    it('returns true when B blocked A (symmetric effect)', () => {
      assert.equal(isBlockedBetween('bob', 'alice', sampleBlocks), true);
    });

    it('returns true when third party (david) blocked A', () => {
      assert.equal(isBlockedBetween('alice', 'david', sampleBlocks), true);
      assert.equal(isBlockedBetween('david', 'alice', sampleBlocks), true);
    });

    it('returns false when no block exists between pair', () => {
      assert.equal(isBlockedBetween('bob', 'charlie', sampleBlocks), false);
    });

    it('returns false for self pair', () => {
      assert.equal(isBlockedBetween('alice', 'alice', sampleBlocks), false);
    });
  });

  describe('blocksBy', () => {
    it('returns blocks created by alice ordered newest first', () => {
      const blocks = blocksBy('alice', sampleBlocks);
      assert.equal(blocks.length, 2);
      assert.equal(blocks[0].blockedId, 'charlie'); // t2
      assert.equal(blocks[1].blockedId, 'bob'); // t1
    });

    it('breaks tie by blockedId ASC when timestamps match', () => {
      const blocksWithTie: readonly BlockEdge[] = [
        { blockerId: 'alice', blockedId: 'zulu', blockedAt: t2 },
        { blockerId: 'alice', blockedId: 'alpha', blockedAt: t2 },
      ];
      const blocks = blocksBy('alice', blocksWithTie);
      assert.equal(blocks[0].blockedId, 'alpha');
      assert.equal(blocks[1].blockedId, 'zulu');
    });

    it('returns empty array when player has blocked no one', () => {
      assert.deepEqual(blocksBy('bob', sampleBlocks), []);
    });
  });
});
