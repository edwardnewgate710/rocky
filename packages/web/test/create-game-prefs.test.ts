import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCreateGamePrefs,
  serializeCreateGamePrefs,
  PREFS_STORAGE_KEY,
} from '../src/app/create-game-prefs.js';
import { VARIANTS, OFFERED_VARIANTS } from '../src/api/models.js';

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
 * is what a player may pick. Asserting both directions is the point — dropping it from the contract
 * list would be a different bug, and this test would catch that too.
 */
test('the lobby does not offer chess960, while the contract still names it', () => {
  assert.equal(VARIANTS.includes('chess960'), true, 'the server enum accepts chess960; the client must still name it');
  assert.equal(
    OFFERED_VARIANTS.includes('chess960' as never),
    false,
    'chess960 must not be selectable while Position.initial returns the standard array',
  );

  // Every other variant stays on offer: this withholds one thing, it does not narrow the lobby.
  for (const v of VARIANTS) {
    if (v === 'chess960') continue;
    assert.ok(OFFERED_VARIANTS.includes(v as never), `${v} must remain selectable`);
  }
});
