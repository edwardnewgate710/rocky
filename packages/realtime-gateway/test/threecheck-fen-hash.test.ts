/**
 * `fenHash` must distinguish Three-Check positions that differ only in checks delivered.
 *
 * The hash is the client's cheap desync check: it compares what the server says the position is
 * against what it last drew. Before the counters were serialised, two boards that looked alike
 * hashed alike even when one player was two checks from winning — so a client could hold a stale
 * view of a decisive difference and see nothing wrong. See ADR-0120.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Position } from '@chess-platform/core';
import { fenHash } from '../src/authority';

const SHUFFLE = '4k3/8/8/8/8/8/8/3R3K w - - 3+3 0 1';

test('the position hash changes when a check is delivered, not only when a piece moves', () => {
  const fresh = Position.fromFen(SHUFFLE, 'threecheck');

  // Re1+ Kf8 Rd1 Ke8 returns every piece to where it started, so the board alone is unchanged.
  const afterShuffle = fresh.play('d1e1').play('e8f8').play('e1d1').play('f8e8');

  assert.equal(
    fresh.fen().split(' ')[0],
    afterShuffle.fen().split(' ')[0],
    'the piece placement really is identical, which is what makes this worth asserting',
  );
  assert.notEqual(
    fenHash(fresh.fen()),
    fenHash(afterShuffle.fen()),
    'a delivered check changes the position, so it must change the hash',
  );
});

test('identical Three-Check positions still hash identically', () => {
  // The other direction: the counters must discriminate, not simply make every hash unique.
  assert.equal(
    fenHash(Position.fromFen(SHUFFLE, 'threecheck').fen()),
    fenHash(Position.fromFen(SHUFFLE, 'threecheck').fen()),
  );
});
