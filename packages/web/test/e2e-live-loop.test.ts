/**
 * End-to-end live gameplay loop test (C1 standing rule).
 *
 * This is the "immune system" test the review found missing. It plays at least
 * two full moves through the full client stack: GameSync ⇄ AuthoritativeMoveOracle
 * ⇄ BoardInteraction, and verifies that the second move is resolvable through
 * the oracle after the first move's broadcast refreshes legalMoves.
 *
 * The test simulates the gateway by emitting server messages manually, using
 * realistic legal-move maps derived from the actual starting position.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WsClient } from '../src/net/ws-client.js';
import { GameSync } from '../src/net/game-sync.js';
import { AuthoritativeMoveOracle } from '../src/net/authoritative-oracle.js';
import { BoardInteraction } from '../src/core/interaction.js';
import type { LegalMoves, StateView } from '../src/net/ws-protocol.js';
import { FakeSocketFactory, ManualScheduler } from './support/fake-socket.js';

/** Legal moves for the starting position (White to move). */
const START_LEGAL: LegalMoves = {
  a2: ['a3', 'a4'], b2: ['b3', 'b4'], c2: ['c3', 'c4'], d2: ['d3', 'd4'],
  e2: ['e3', 'e4'], f2: ['f3', 'f4'], g2: ['g3', 'g4'], h2: ['h3', 'h4'],
  b1: ['a3', 'c3'], g1: ['f3', 'h3'],
};

/** After 1.e4, Black's legal moves (subset — enough for the test). */
const AFTER_E4_LEGAL: LegalMoves = {
  a7: ['a6', 'a5'], b7: ['b6', 'b5'], c7: ['c6', 'c5'], d7: ['d6', 'd5'],
  e7: ['e6', 'e5'], f7: ['f6', 'f5'], g7: ['g6', 'g5'], h7: ['h6', 'h5'],
  b8: ['a6', 'c6'], g8: ['f6', 'h6'],
};

/** After 1.e4 e5, White's legal moves (subset — enough for the test). */
const AFTER_E4_E5_LEGAL: LegalMoves = {
  a2: ['a3', 'a4'], b2: ['b3', 'b4'], c2: ['c3', 'c4'], d2: ['d3', 'd4'],
  f2: ['f3', 'f4'], g2: ['g3', 'g4'], h2: ['h3', 'h4'],
  b1: ['a3', 'c3'], g1: ['f3', 'h3'], e4: ['e5'],
};

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const AFTER_E4_E5_FEN = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';

function makeStateView(
  ply: number,
  turn: 'w' | 'b',
  fen: string,
  moves: StateView['moves'],
  legalMoves: LegalMoves,
): StateView {
  return {
    gameId: 'g1',
    variant: 'standard',
    players: { white: 'alice', black: 'bob' },
    timeControl: { initialMs: 300_000, incrementMs: 3_000, delayMs: 0, kind: 'increment' },
    fen,
    fenHash: `h${ply}`,
    ply,
    turn,
    clock: { w: 300_000, b: 300_000 },
    status: { over: false },
    drawOffer: null,
    moves,
    legalMoves,
  };
}

function setup() {
  const factory = new FakeSocketFactory();
  const scheduler = new ManualScheduler();
  const client = new WsClient({
    url: 'wss://example.test/ws',
    factory: factory.factory,
    scheduler,
    now: () => 0,
    rng: () => 0,
    heartbeatMs: 0,
    reconnect: { baseDelayMs: 10, maxDelayMs: 10, jitter: 'none' },
  });
  const sync = new GameSync(client, { gameId: 'g1', userId: 'alice' });
  return { factory, scheduler, client, sync };
}

test('C1 e2e: two-move live loop through GameSync + Oracle + BoardInteraction', () => {
  const { factory, sync } = setup();

  // Wire up the full client stack.
  const oracle = new AuthoritativeMoveOracle({
    getLegalMoves: () => sync.getState().legalMoves,
  });
  const interaction = new BoardInteraction({ oracle, myTurn: true });

  // Start the sync and join as White.
  sync.start();
  factory.last.open();

  // Server sends the joined message with the starting position.
  factory.last.emit({
    t: 'joined', gameId: 'g1', role: 'white',
    state: makeStateView(0, 'w', START_FEN, [], START_LEGAL),
  });

  // Sync the interaction to the current position.
  interaction.setPosition(sync.getState().snapshot!.fen);
  interaction.setTurn(true); // White to move, we are White.

  // --- Move 1: White plays e4 ---
  // The interaction should be able to resolve e2-e4.
  interaction.tap('e2');
  const r1 = interaction.tap('e4');
  assert.equal(r1.kind, 'move', 'e2-e4 should resolve as a move');
  if (r1.kind === 'move') {
    assert.equal(r1.move.from, 'e2');
    assert.equal(r1.move.to, 'e4');
  }

  // Submit the move through GameSync.
  const pending = sync.submitMove('e2e4');
  assert.ok(pending, 'submitMove should return a pending move');

  // Server broadcasts the move with the resulting legal moves for Black.
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e2e4', san: 'e4', by: 'w',
    fenHash: 'h1', clock: { w: 297_000, b: 300_000 }, serverTs: 1,
    legalMoves: AFTER_E4_LEGAL,
  });

  // After the broadcast, it's Black's turn — we should not be able to move.
  assert.equal(sync.getState().turn, 'b');
  assert.equal(sync.getState().myColor, 'w');
  interaction.setPosition(AFTER_E4_FEN);
  interaction.setTurn(false); // Not our turn.

  // --- Simulate opponent's move (e5) via broadcast ---
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 2, uci: 'e7e5', san: 'e5', by: 'b',
    fenHash: 'h2', clock: { w: 297_000, b: 297_000 }, serverTs: 2,
    legalMoves: AFTER_E4_E5_LEGAL,
  });

  // Now it's White's turn again. The oracle should have fresh legal moves.
  assert.equal(sync.getState().turn, 'w');
  interaction.setPosition(AFTER_E4_E5_FEN);
  interaction.setTurn(true);

  // --- Move 2: White plays Nf3 (g1-f3) ---
  // This is the critical assertion: after a live broadcast, the oracle must
  // still provide destinations. Before the C1 fix, legalMoves would have been
  // wiped to {} and this would fail.
  const dests = oracle.destinations('g1');
  assert.ok(dests.includes('f3'), 'g1 should have f3 as a legal destination after 1.e4 e5');

  interaction.tap('g1');
  const r2 = interaction.tap('f3');
  assert.equal(r2.kind, 'move', 'g1-f3 should resolve as a move (second move in live loop)');
  if (r2.kind === 'move') {
    assert.equal(r2.move.from, 'g1');
    assert.equal(r2.move.to, 'f3');
  }

  // Submit the second move.
  const pending2 = sync.submitMove('g1f3');
  assert.ok(pending2, 'second submitMove should return a pending move');
  assert.equal(pending2!.uci, 'g1f3');

  sync.stop();
});

test('C1 e2e: resume after disconnect replays correctly with legalMoves', () => {
  const { factory, sync } = setup();
  const oracle = new AuthoritativeMoveOracle({
    getLegalMoves: () => sync.getState().legalMoves,
  });

  sync.start();
  factory.last.open();

  // Join and play first move.
  factory.last.emit({
    t: 'joined', gameId: 'g1', role: 'white',
    state: makeStateView(0, 'w', START_FEN, [], START_LEGAL),
  });

  sync.submitMove('e2e4');
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e2e4', san: 'e4', by: 'w',
    fenHash: 'h1', clock: { w: 297_000, b: 300_000 }, serverTs: 1,
    legalMoves: AFTER_E4_LEGAL,
  });

  // Simulate disconnect + reconnect.
  factory.last.close();
  factory.last.open();

  // Server sends resumed with current state (ply 1, Black to move).
  factory.last.emit({
    t: 'resumed', gameId: 'g1',
    state: makeStateView(1, 'b', AFTER_E4_FEN, [
      { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' },
    ], AFTER_E4_LEGAL),
    missed: [],
  });

  // After resume, legalMoves should be populated from the snapshot.
  assert.deepEqual(sync.getState().legalMoves, AFTER_E4_LEGAL);
  assert.equal(sync.getState().ply, 1);

  // The oracle should work after resume.
  oracle.setPosition(AFTER_E4_FEN);
  const dests = oracle.destinations('e7');
  assert.ok(dests.includes('e5'), 'e7 should have e5 as a legal destination after resume');

  sync.stop();
});
