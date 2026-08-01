import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertDistinct, normalizePair } from '../src/relation';
import { SocialRuleError } from '../src/errors';

describe('relation utilities', () => {
  describe('assertDistinct', () => {
    it('passes when player IDs are distinct', () => {
      assert.doesNotThrow(() => assertDistinct('player_a', 'player_b'));
    });

    it('throws SocialRuleError with code self_relation when IDs match', () => {
      assert.throws(
        () => assertDistinct('player_a', 'player_a'),
        (err: unknown) => err instanceof SocialRuleError && err.code === 'self_relation'
      );
    });

    it('includes informative message in error', () => {
      try {
        assertDistinct('alice', 'alice');
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof SocialRuleError);
        assert.equal(err.code, 'self_relation');
        assert.ok(err.message.length > 0);
      }
    });
  });

  describe('normalizePair', () => {
    it('returns [a, b] when a < b', () => {
      const pair = normalizePair('alice', 'bob');
      assert.deepEqual(pair, ['alice', 'bob']);
    });

    it('returns [a, b] when b < a (canonical sorting)', () => {
      const pair = normalizePair('bob', 'alice');
      assert.deepEqual(pair, ['alice', 'bob']);
    });

    it('returns consistent tuple regardless of parameter order', () => {
      const pair1 = normalizePair('p100', 'p200');
      const pair2 = normalizePair('p200', 'p100');
      assert.deepEqual(pair1, pair2);
      assert.equal(pair1[0], 'p100');
      assert.equal(pair1[1], 'p200');
    });

    it('handles identical IDs (though invalid in relations)', () => {
      const pair = normalizePair('same', 'same');
      assert.deepEqual(pair, ['same', 'same']);
    });
  });
});
