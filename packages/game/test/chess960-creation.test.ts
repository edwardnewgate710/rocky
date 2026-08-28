import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, GameError } from '../src/game';
import { Position, type Variant } from '@chess-platform/core';
import type { GameEvent } from '../src/events';
import type { TimeControl } from '../src/clock';

/**
 * `Game.create` is the one place a game is born — seek acceptance, the bot route and the tournament
 * launcher all arrive here — so it is where the Chess960 refusal has to hold. ADR-0123.
 */

const TC: TimeControl = { initialMs: 300_000, incrementMs: 3_000, delayMs: 0, kind: 'increment' };

const create = (variant?: Variant) =>
  Game.create({
    gameId: 'g1',
    ...(variant === undefined ? {} : { variant }),
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: true,
    at: 0,
  });

test('the premise has changed: the rules exist now, so the refusal rests on something else', () => {
  // This test used to assert that `Position.initial('chess960')` was the standard array and conclude
  // from that that Chess960 was unplayable. The premise is dead: ADR-0136 implements all 960
  // arrangements and castling from arbitrary king and rook squares, verified against published perft
  // counts. Left as it was, it would have gone on passing while the reason it existed had evaporated.
  //
  // What it asserts instead is the reason the refusal still stands. The engine can play any
  // arrangement, but `Game.create` has no way to be *told* which one — no parameter and no event
  // field carries a starting-position id. A game created today could therefore only ever be position
  // 518, recorded as `chess960` without anyone having chosen it: the same durable falsehood ADR-0123
  // refused, arrived at from the opposite direction.
  const distinct = new Set(
    [0, 1, 42, 517, 518, 519, 959].map((id) => Position.chess960(id).fen()),
  );
  assert.equal(distinct.size, 7, 'the engine really does produce distinct Chess960 positions now');

  assert.equal(
    Position.initial('chess960').fen(),
    Position.initial('standard').fen(),
    'while the default stays position 518, the traditional array, deliberately chosen by nobody',
  );
});

test('creating a chess960 game is refused', () => {
  assert.throws(
    () => create('chess960'),
    (err: unknown) => err instanceof GameError && /chess960/.test(err.message),
  );
});

test('a refused chess960 creation emits no event at all', () => {
  // The point of refusing here rather than at the API: `GameCreated` goes to an append-only store,
  // so an event carrying `variant: 'chess960'` beside a standard `initialFen` is permanent. Nothing
  // may be emitted on the way to the refusal.
  let emitted: unknown = 'never assigned';
  try {
    emitted = create('chess960');
    assert.fail('creation should have thrown');
  } catch (err) {
    assert.ok(err instanceof GameError);
  }
  assert.equal(emitted, 'never assigned', 'no events object was produced');
});

test('an explicit initialFen does not buy a way past the refusal', () => {
  // The obvious bypass: supply a real Chess960 arrangement and skip `Position.initial`. The engine
  // still cannot castle from it — castling generation is hardcoded to e1/a1/h1 — so the game would
  // be wrong in a different way. Refused on the variant, not on how the position arrived.
  assert.throws(
    () =>
      Game.create({
        gameId: 'g1',
        variant: 'chess960',
        initialFen: 'nrbqkbrn/pppppppp/8/8/8/8/PPPPPPPP/NRBQKBRN w KQkq - 0 1',
        timeControl: TC,
        players: { white: 'alice', black: 'bob' },
        rated: true,
        at: 0,
      }),
    (err: unknown) => err instanceof GameError,
  );
});

/** The variant recorded on the `GameCreated` event — the value that actually gets persisted. */
function createdVariant(events: readonly GameEvent[]): Variant | undefined {
  const created = events[0];
  return created?.type === 'GameCreated' ? created.variant : undefined;
}

test('standard creation still works, with and without an explicit variant', () => {
  for (const variant of [undefined, 'standard' as const]) {
    const { events } = create(variant);
    assert.equal(events.length, 1);
    assert.equal(createdVariant(events), 'standard');
  }
});

test('every other variant still creates', () => {
  // The refusal must be one name, not a general narrowing. A change that broke Crazyhouse creation
  // while blocking Chess960 would pass a test that only checked Chess960.
  for (const variant of [
    'kingofthehill',
    'atomic',
    'crazyhouse',
    'threecheck',
    'horde',
    'racingkings',
  ] as const) {
    const { events } = create(variant);
    assert.equal(events.length, 1, `${variant} must still create`);
    assert.equal(createdVariant(events), variant);
  }
});
