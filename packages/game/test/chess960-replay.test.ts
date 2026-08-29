import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, GameError } from '../src/game';
import { chess960Fen } from '@chess-platform/core';
import type { GameCreatedEvent, GameEvent } from '../src/events';
import type { TimeControl } from '../src/clock';

/**
 * Replay is where the Chess960 start contract is actually load-bearing.
 *
 * `Game.create` runs once, in a process that no longer exists by the time anyone asks what a game
 * started as. `Game.fromEvents` runs on every reconnect, every eviction, every restart — reading JSON
 * that some earlier version of this code wrote. So the checks that matter are the ones on the way
 * *out* of the store, and these tests drive the reducer directly with hand-built events rather than
 * through `Game.create`, because a stored payload is not obliged to be something `Game.create` would
 * have produced. ADR-0137.
 */

const TC: TimeControl = { initialMs: 300_000, incrementMs: 3_000, delayMs: 0, kind: 'increment' };
const SP700 = 700;

/**
 * White's back rank as eight characters, file a first, with empty squares as `.`.
 *
 * FEN run-length-encodes empty squares, so `indexOf` on the raw rank reports a position in the
 * *string* rather than a file — `2KRNNBR` would put the king on file b. Expanding first is what makes
 * "the king finished on c1" an assertion about the board.
 */
function whiteBackRank(fen: string): string {
  const rank = fen.split(' ')[0]!.split('/')[7]!;
  return [...rank].map((c) => (/\d/.test(c) ? '.'.repeat(Number(c)) : c)).join('');
}

/**
 * A `GameCreated` event for position 700, with `over` applied on top.
 *
 * Hand-built rather than produced by `Game.create`, which is the point: a stored payload is whatever
 * some earlier version of this code wrote, and the reducer has to cope with shapes `Game.create`
 * would refuse to emit. The `as GameEvent` cast is what lets a test express those.
 */
function createdEvent(over: Partial<GameCreatedEvent> = {}): GameEvent {
  return {
    type: 'GameCreated',
    gameId: 'g1',
    variant: 'chess960',
    initialFen: chess960Fen(SP700),
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: true,
    at: 0,
    chess960StartId: SP700,
    ...over,
  } as GameEvent;
}

test('a chess960 game replays to the exact arrangement it was created with', () => {
  const { events } = Game.create({
    gameId: 'g1',
    variant: 'chess960',
    chess960StartId: SP700,
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: true,
    at: 0,
  });
  const replayed = Game.fromEvents(events);
  assert.equal(replayed.fen, chess960Fen(SP700));
  assert.equal(replayed.snapshot().chess960StartId, SP700);
});

test('the start survives moves: the id is fixed at creation and the board moves on', () => {
  // The reason the id has to be stored at all. Once a move is played the FEN describes the current
  // position, so nothing in it says which of the 960 the game began as — the id is the only record.
  let { game, events } = Game.create({
    gameId: 'g1',
    variant: 'chess960',
    chess960StartId: SP700,
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: true,
    at: 0,
  });
  const log: GameEvent[] = [...events];
  for (const [uci, at] of [['e2e4', 1_000], ['e7e5', 2_000], ['f1g3', 3_000]] as const) {
    ({ game, events } = game.playMove(uci, at));
    log.push(...events);
  }

  assert.notEqual(game.fen, chess960Fen(SP700), 'the board has moved on');
  assert.equal(game.snapshot().chess960StartId, SP700, 'the start id has not');

  const replayed = Game.fromEvents(log);
  assert.equal(replayed.fen, game.fen, 'replay reproduces the live game exactly');
  assert.equal(replayed.snapshot().chess960StartId, SP700);
});

test('castling by king-takes-rook replays, rook and all', () => {
  // `d1a1` is the queenside castle for position 700: king d1 -> c1, rook a1 -> d1. It is worth
  // replaying specifically because `d1c1` is also a legal ordinary king move, so a replay that
  // resolved the move by from/to alone would silently play a different game than the one recorded
  // (ADR-0136 §4).
  let { game, events } = Game.create({
    gameId: 'g1',
    variant: 'chess960',
    chess960StartId: SP700,
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: true,
    at: 0,
  });
  const log: GameEvent[] = [...events];
  // Clearing b1 and c1 is what a queenside castle needs here: the queen up the c-file once the pawn
  // has moved, then the bishop off b1.
  const line = [
    ['c2c4', 1_000], ['h7h6', 2_000],
    ['c1c3', 3_000], ['g7g6', 4_000],
    ['b1c2', 5_000], ['a7a6', 6_000],
    ['d1a1', 7_000],
  ] as const;
  for (const [uci, at] of line) {
    ({ game, events } = game.playMove(uci, at));
    log.push(...events);
  }

  assert.equal(whiteBackRank(game.fen), '..KRNNBR', 'king on c1, rook on d1 — where the king started');
  assert.equal(Game.fromEvents(log).fen, game.fen);
});

// --- What the reducer refuses on the way out of the store --------------------

test('a stored id that disagrees with the stored FEN is refused', () => {
  // Both fields are persisted, so both can be tampered with independently — and a client that
  // fabricated an initial state would show up here and nowhere else. Exact equality against
  // `chess960Fen(id)` means agreement is the only thing that passes.
  assert.throws(
    () => Game.fromEvents([createdEvent({ initialFen: chess960Fen(519) })]),
    (err: unknown) => err instanceof GameError && /is not that position/.test(err.message),
  );
});

test('a stored out-of-range or non-integer id is refused', () => {
  for (const id of [-1, 960, 3.5]) {
    assert.throws(
      () => Game.fromEvents([createdEvent({ chess960StartId: id })]),
      (err: unknown) => err instanceof GameError && /not an\s+integer/.test(err.message.replace(/\s+/g, ' ')),
      `stored id ${id} must be refused`,
    );
  }
});

test('a start id on a non-chess960 stored event is refused', () => {
  assert.throws(
    () =>
      Game.fromEvents([
        createdEvent({
          variant: 'standard',
          initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          chess960StartId: 42,
        }),
      ]),
    (err: unknown) => err instanceof GameError && /only chess960 games have one/.test(err.message),
  );
});

// --- Backward compatibility --------------------------------------------------

test('a stored event from before the field existed still decodes', () => {
  // The append-only store holds events written by earlier versions of this code. Every one of them
  // lacks `chess960StartId`, and all of them must keep loading.
  const legacyStandard = createdEvent({
    variant: 'standard',
    initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  }) as unknown as Record<string, unknown>;
  delete legacyStandard['chess960StartId'];

  const game = Game.fromEvents([legacyStandard as unknown as GameEvent]);
  assert.equal(game.snapshot().variant, 'standard');
  assert.equal(game.snapshot().chess960StartId, null);
});

test('a legacy chess960 event replays from its FEN and reports an unknown start, never 518', () => {
  // A `chess960` row written before ADR-0137 recorded no id. Its *position* is still exactly what was
  // stored, so it replays unchanged — but its identity was never captured, and the honest answer is
  // that nobody knows. Filling in 518 would be a guess wearing the shape of a fact, and 518 is
  // precisely the guess that would look right on the games that were mislabelled standard.
  const legacy = createdEvent({
    initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  }) as unknown as Record<string, unknown>;
  delete legacy['chess960StartId'];

  const game = Game.fromEvents([legacy as unknown as GameEvent]);
  assert.equal(game.snapshot().variant, 'chess960');
  assert.equal(game.fen, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert.equal(
    game.snapshot().chess960StartId,
    null,
    'unknown is reported as unknown, not resolved to 518',
  );
});
