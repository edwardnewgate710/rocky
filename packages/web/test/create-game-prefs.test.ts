import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCreateGamePrefs,
  serializeCreateGamePrefs,
  PREFS_STORAGE_KEY,
} from '../src/app/create-game-prefs.js';
import { VARIANTS, OFFERED_VARIANTS } from '../src/api/models.js';
import type { Variant } from '../src/api/models.js';

test('parse returns null for missing / malformed input', () => {
  assert.equal(parseCreateGamePrefs(null), null);
  assert.equal(parseCreateGamePrefs(''), null);
  assert.equal(parseCreateGamePrefs('not json'), null);
  assert.equal(parseCreateGamePrefs('42'), null);
  assert.equal(parseCreateGamePrefs('null'), null);
});

test('parse accepts a valid preset + mode', () => {
  assert.deepEqual(parseCreateGamePrefs('{"time":"5+3","mode":"rated"}'), {
    time: '5+3',
    mode: 'rated',
  });
});

test('parse rejects an unknown preset id', () => {
  assert.equal(parseCreateGamePrefs('{"time":"7+7","mode":"casual"}'), null);
});

test('parse rejects an invalid mode', () => {
  assert.equal(parseCreateGamePrefs('{"time":"5+0","mode":"ranked"}'), null);
  assert.equal(parseCreateGamePrefs('{"time":"5+0"}'), null);
});

test('parse accepts custom time within limits and rejects out of range', () => {
  assert.deepEqual(parseCreateGamePrefs('{"time":"custom","minutes":7,"increment":4,"mode":"casual"}'), {
    time: 'custom',
    minutes: 7,
    increment: 4,
    mode: 'casual',
  });
  // minutes above the max
  assert.equal(parseCreateGamePrefs('{"time":"custom","minutes":9999,"increment":0,"mode":"casual"}'), null);
  // increment above the max
  assert.equal(parseCreateGamePrefs('{"time":"custom","minutes":5,"increment":999,"mode":"casual"}'), null);
  // missing custom fields
  assert.equal(parseCreateGamePrefs('{"time":"custom","mode":"casual"}'), null);
});

test('serialize round-trips through parse', () => {
  const prefs = { time: 'custom' as const, minutes: 3, increment: 2, mode: 'rated' as const };
  assert.deepEqual(parseCreateGamePrefs(serializeCreateGamePrefs(prefs)), prefs);
});

test('storage key is stable', () => {
  assert.equal(PREFS_STORAGE_KEY, 'gambit-create-game');
});

/**
 * Chess960 was selectable in the lobby while nothing behind it existed:
 * `Position.initial('chess960')` returns the standard array rather than one of the 960 arrangements,
 * and castling in `packages/chess-core` is hardcoded to e1/a1/h1, so it works only from the start
 * position that *is* standard chess. Picking it produced an ordinary game with a different label.
 *
 * The two lists are separate on purpose (ADR-0099). `VARIANTS` mirrors what the server's enum
 * accepts and must keep naming `chess960`, because the API really does take it; `OFFERED_VARIANTS`
 * is what a player may pick.
 *
 * The offered set is asserted exactly, not as "everything except chess960". Phrasing it as an
 * exception makes offering the default, so a variant added to `VARIANTS` tomorrow would be
 * selectable the moment it was named — which is how a variant with nothing behind it got on the
 * board to begin with. Written this way, adding one fails here until somebody decides, and the
 * decision is recorded in this list.
 */
const EXPECTED_OFFERED: readonly Variant[] = [
  'standard',
  'kingofthehill',
  'atomic',
  'crazyhouse',
  'threecheck',
  'horde',
  'racingkings',
];

test('the lobby offers exactly the variants that work, and the contract still names chess960', () => {
  assert.deepEqual(
    [...OFFERED_VARIANTS].sort(),
    [...EXPECTED_OFFERED].sort(),
    'a new variant is not offered until it is added here deliberately',
  );

  // The contract list is the server's enum and must keep naming chess960; dropping it there would be
  // a different bug, and this catches that too.
  assert.equal(VARIANTS.includes('chess960'), true);
  assert.equal(
    OFFERED_VARIANTS.includes('chess960'),
    false,
    'chess960 must not be selectable while Position.initial returns the standard array',
  );

  // Nothing offered may be absent from the contract: a typo here would render an option the server
  // rejects.
  for (const v of OFFERED_VARIANTS) {
    assert.ok(VARIANTS.includes(v), `${v} is offered but is not a contract variant`);
  }
});
