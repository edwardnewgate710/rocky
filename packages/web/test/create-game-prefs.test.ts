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

test('parse accepts a valid V1 preset + mode', () => {
  assert.deepEqual(parseCreateGamePrefs('{"time":"15+10","mode":"rated"}'), {
    time: '15+10',
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

test('parse rejects legacy and custom time controls', () => {
  for (const time of ['1+0', '3+2', '5+3', '10+5', '30+20']) {
    assert.equal(parseCreateGamePrefs(JSON.stringify({ time, mode: 'casual' })), null);
  }
  assert.equal(
    parseCreateGamePrefs('{"time":"custom","minutes":7,"increment":4,"mode":"casual"}'),
    null,
  );
});

test('serialize round-trips through parse', () => {
  const prefs = { time: '5+0' as const, mode: 'rated' as const };
  assert.deepEqual(parseCreateGamePrefs(serializeCreateGamePrefs(prefs)), prefs);
});

test('storage key is stable', () => {
  assert.equal(PREFS_STORAGE_KEY, 'gambit-create-game');
});

/**
 * Chess960 was selectable in the lobby while nothing behind it existed — ADR-0099 withheld it, and
 * ADR-0137 offers it again now that the server implements the rules (ADR-0136), draws a
 * starting-position id at creation, and records it on the `GameCreated` event.
 *
 * The two lists stay separate on purpose, even now that they agree. `VARIANTS` mirrors what the
 * server's enum accepts; `OFFERED_VARIANTS` is what a player may pick. Conflating them is what let a
 * hollow variant stay on the board, and re-deriving the distinction later is not the same as never
 * having lost it.
 *
 * The offered set is asserted exactly, not as "everything the contract names". Phrasing it as a
 * derivation makes offering the default, so a variant added to `VARIANTS` tomorrow would be
 * selectable the moment it was named — exactly how a variant with nothing behind it got on the board
 * to begin with. Written this way, adding one fails here until somebody decides, and the decision is
 * recorded in this list.
 */
const EXPECTED_OFFERED: readonly Variant[] = [
  'standard',
  'chess960',
  'kingofthehill',
  'atomic',
  'crazyhouse',
  'threecheck',
  'horde',
  'racingkings',
];

test('the lobby offers exactly the variants that work, chess960 among them', () => {
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
    true,
    'chess960 is selectable now that the server chooses and records a starting position',
  );

  // Nothing offered may be absent from the contract: a typo here would render an option the server
  // rejects.
  for (const v of OFFERED_VARIANTS) {
    assert.ok(VARIANTS.includes(v), `${v} is offered but is not a contract variant`);
  }
});
