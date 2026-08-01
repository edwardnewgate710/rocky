import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareIds, compareRecentThenId } from '../src/ordering';
import { normalizePair } from '../src/relation';

describe('ordering', () => {
  const earlier = new Date('2026-01-01T10:00:00Z');
  const later = new Date('2026-01-02T10:00:00Z');

  describe('compareIds', () => {
    it('orders by code point, not by locale collation', () => {
      // The regression this pins: `'a'.localeCompare('B')` is negative (locale-aware collation
      // ignores case), while code-point order puts every uppercase letter first. Postgres
      // reproduces code-point order only with `COLLATE "C"`, so if this ever flips, the adapter in
      // increment 2 and the in-memory adapter paginate two different sequences.
      assert.ok(compareIds('B', 'a') < 0);
      assert.ok(compareIds('a', 'B') > 0);
      assert.ok('a'.localeCompare('B') < 0, 'locale collation disagrees — that is the point');
    });

    it('is consistent with normalizePair', () => {
      const ids = ['Zulu', 'alpha', 'Bravo', 'zulu', '10', '9'];
      for (const a of ids) {
        for (const b of ids) {
          if (a === b) {
            continue;
          }
          const [low] = normalizePair(a, b);
          const expected = compareIds(a, b) < 0 ? a : b;
          assert.equal(low, expected, `normalizePair disagrees with compareIds on ${a}/${b}`);
        }
      }
    });

    it('returns 0 for equal ids', () => {
      assert.equal(compareIds('alice', 'alice'), 0);
    });

    it('sorts numeric-looking ids lexically, since ids are strings', () => {
      assert.ok(compareIds('10', '9') < 0);
    });
  });

  describe('compareRecentThenId', () => {
    it('puts the newer timestamp first regardless of id', () => {
      assert.ok(compareRecentThenId(earlier, 'aaa', later, 'zzz') > 0);
      assert.ok(compareRecentThenId(later, 'zzz', earlier, 'aaa') < 0);
    });

    it('falls back to id ascending on identical timestamps', () => {
      assert.ok(compareRecentThenId(earlier, 'alpha', earlier, 'zulu') < 0);
      assert.ok(compareRecentThenId(earlier, 'zulu', earlier, 'alpha') > 0);
    });

    it('is a total order, so sorting is repeatable', () => {
      const rows = [
        { at: earlier, id: 'zulu' },
        { at: later, id: 'bravo' },
        { at: earlier, id: 'alpha' },
        { at: later, id: 'Alpha' },
      ];
      const sortOnce = (input: typeof rows): string[] =>
        [...input]
          .sort((a, b) => compareRecentThenId(a.at, a.id, b.at, b.id))
          .map((r) => r.id);

      const expected = ['Alpha', 'bravo', 'alpha', 'zulu'];
      assert.deepEqual(sortOnce(rows), expected);
      assert.deepEqual(sortOnce([...rows].reverse()), expected);
    });

    it('returns 0 only when both timestamp and id match', () => {
      assert.equal(compareRecentThenId(earlier, 'alice', earlier, 'alice'), 0);
    });
  });
});
