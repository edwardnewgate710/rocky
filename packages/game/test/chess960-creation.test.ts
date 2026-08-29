import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, GameError } from '../src/game';
import { Position, chess960Fen, type Variant } from '@chess-platform/core';
import type { GameCreatedEvent, GameEvent } from '../src/events';
import type { TimeControl } from '../src/clock';

/**
 * `Game.create` is the one place a game is born — seek acceptance, the bot route and the tournament
 * launcher all arrive here — so it is where the Chess960 starting-position contract has to hold.
 * ADR-0137, which replaces the refusal ADR-0123 put here with the thing that was missing.
 */

const TC: TimeControl = { initialMs: 300_000, incrementMs: 3_000, delayMs: 0, kind: 'increment' };

/**
 * A starting position that is emphatically not the traditional array: king on d1, rooks on a1 and h1.
 *
 * Chosen so an implementation that quietly fell back to 518 could not pass. Its queenside castle is
 * the interesting one — `d1a1` puts the king on c1, which is also where an ordinary one-square king
 * step lands, so the two are distinguishable only by the rook-square spelling (ADR-0136 §4).
 */
const SP700 = 700;

/**
 * Create a game with the fixed time control and players these tests share.
 *
 * Both parameters are optional and omitted rather than passed as `undefined`, because `Game.create`
 * distinguishes "absent" from "present but undefined" for `chess960StartId` — that distinction is
 * half of what this file tests.
 */
const create = (variant?: Variant, chess960StartId?: number) =>
  Game.create({
    gameId: 'g1',
    ...(variant === undefined ? {} : { variant }),
    ...(chess960StartId === undefined ? {} : { chess960StartId }),
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: true,
    at: 0,
  });

/** The `GameCreated` event — the thing that actually gets persisted. */
function created(events: readonly GameEvent[]): GameCreatedEvent {
  const first = events[0];
  assert.ok(first !== undefined && first.type === 'GameCreated', 'first event must be GameCreated');
  return first;
}

test('a chess960 game is created from the id it was given, and records it', () => {
  const { game, events } = create('chess960', SP700);
  assert.equal(events.length, 1);

  const ev = created(events);
  assert.equal(ev.variant, 'chess960');
  assert.equal(ev.chess960StartId, SP700, 'the arrangement is recorded, not left to be inferred');
  assert.equal(ev.initialFen, chess960Fen(SP700));
  assert.equal(game.fen, chess960Fen(SP700));
  assert.equal(game.snapshot().chess960StartId, SP700);
});

test('the id chooses the board: a non-518 game is visibly not standard chess', () => {
  // The failure this exists to catch is an implementation that accepts an id, stores it, and starts
  // the traditional array anyway. Asserting "an id came back" would pass that; asserting the board
  // does not.
  const { game } = create('chess960', SP700);
  const backRank = game.fen.split(' ')[0]!.split('/')[7];
  assert.equal(backRank, 'RBQKNNBR');
  assert.notEqual(game.fen, Position.initial('standard').fen());
  assert.equal(backRank!.indexOf('K'), 3, 'the king starts on d1, not e1');
});

test('position 518 is the traditional array, and says so on the wire', () => {
  // Not a special case in the code — a property of the Scharnagl numbering (ADR-0136 §1). Worth
  // pinning because it is what lets a Chess960 game and a standard game agree where they should.
  const { game, events } = create('chess960', 518);
  assert.equal(game.fen, Position.initial('standard').fen());
  assert.equal(created(events).chess960StartId, 518, 'still recorded: 518 was chosen, not defaulted to');
});

test('a chess960 game without a starting-position id is refused', () => {
  // The id is required rather than defaulted. Defaulting to 518 would make the traditional array the
  // silent answer to "which arrangement?", leaving a real Chess960 game and a caller that forgot to
  // draw one indistinguishable in an append-only store.
  assert.throws(
    () => create('chess960'),
    (err: unknown) => err instanceof GameError && /starting-position id/.test(err.message),
  );
});

test('a refused creation emits no event at all', () => {
  // The point of refusing here rather than at the API: `GameCreated` goes to an append-only store, so
  // an event carrying a variant its position does not match is permanent. Nothing may be emitted on
  // the way to the refusal.
  let emitted: unknown = 'never assigned';
  try {
    emitted = create('chess960');
    assert.fail('creation should have thrown');
  } catch (err) {
    assert.ok(err instanceof GameError);
  }
  assert.equal(emitted, 'never assigned', 'no events object was produced');
});

test('out-of-range and non-integer starting-position ids are refused', () => {
  for (const id of [-1, 960, 1000, 3.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => create('chess960', id),
      (err: unknown) => err instanceof GameError && /starting-position id/.test(err.message),
      `id ${id} must be refused`,
    );
  }
  // The two ends of the range are ids, not errors.
  for (const id of [0, 959]) {
    assert.equal(created(create('chess960', id).events).chess960StartId, id);
  }
});

test('chess960 refuses an initialFen: the id already determines the position', () => {
  // Two ways to state one fact is two facts that can disagree. The bypass this blocks is supplying an
  // arrangement directly and skipping the id, which would put a position on the board that no
  // recorded id accounts for.
  assert.throws(
    () =>
      Game.create({
        gameId: 'g1',
        variant: 'chess960',
        chess960StartId: SP700,
        initialFen: 'nrbqkbrn/pppppppp/8/8/8/8/PPPPPPPP/NRBQKBRN w KQkq - 0 1',
        timeControl: TC,
        players: { white: 'alice', black: 'bob' },
        rated: true,
        at: 0,
      }),
    (err: unknown) => err instanceof GameError && /initialFen/.test(err.message),
  );
});

test('every other variant refuses a starting-position id', () => {
  // The mirror of the rule above, and the one that keeps Chess960 from leaking: a `standard` game
  // carrying a start id would be describing a game that does not exist.
  for (const variant of ['standard', 'atomic', 'horde', 'racingkings'] as const) {
    assert.throws(
      () => create(variant, SP700),
      (err: unknown) => err instanceof GameError && /meaningless/.test(err.message),
      `${variant} must refuse a chess960 start id`,
    );
  }
});

test('standard creation still works, with and without an explicit variant', () => {
  for (const variant of [undefined, 'standard' as const]) {
    const { events } = create(variant);
    assert.equal(events.length, 1);
    assert.equal(created(events).variant, 'standard');
    assert.equal(
      created(events).chess960StartId,
      undefined,
      'no id is fabricated for a variant that has none',
    );
  }
});

test('every other variant still creates', () => {
  // A change that broke Crazyhouse creation while enabling Chess960 would pass a test that only
  // checked Chess960.
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
    assert.equal(created(events).variant, variant);
    assert.equal(created(events).chess960StartId, undefined);
  }
});
