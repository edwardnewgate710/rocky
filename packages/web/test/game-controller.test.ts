import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WsClient } from '../src/net/ws-client.js';
import { GameSync } from '../src/net/game-sync.js';
import { GameController } from '../src/app/game-controller.js';
import type { StateView, WsColor } from '../src/net/ws-protocol.js';
import { FakeSocketFactory, ManualScheduler } from './support/fake-socket.js';

function setup(myColor: WsColor | null = 'w') {
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
  const sync = new GameSync(client, { gameId: 'g1', userId: 'u1' });
  const positions: string[] = [];
  const turns: boolean[] = [];
  const clocks: Array<[number, number]> = [];
  const statuses: string[] = [];
  const controller = new GameController({
    gameSync: sync,
    myColor,
    callbacks: {
      onPosition: (fen) => positions.push(fen),
      onTurn: (myTurn) => turns.push(myTurn),
      onClock: (w, b) => clocks.push([w, b]),
      onStatus: (text) => statuses.push(text),
    },
  });
  return { factory, scheduler, client, sync, controller, positions, turns, clocks, statuses };
}

function stateView(
  ply: number,
  turn: WsColor,
  fen: string,
  moves: StateView['moves'] = [],
): StateView {
  return {
    gameId: 'g1',
    variant: 'standard',
    players: { white: 'u1', black: 'u2' },
    timeControl: { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    fen,
    fenHash: `h${ply}`,
    ply,
    turn,
    clock: { w: 60_000, b: 60_000 },
    status: { over: false },
    drawOffer: null,
    moves,
    legalMoves: {},
  };
}

test('start emits current (pre-join) state — empty position, waiting status', () => {
  const { controller, positions, turns, clocks, statuses } = setup();
  controller.start();
  // No snapshot yet — no position emitted.
  assert.equal(positions.length, 0);
  // Turn is null → myTurn = false.
  assert.deepEqual(turns, [false]);
  // No clock yet.
  assert.equal(clocks.length, 0);
  // Status should be "Waiting…"
  assert.equal(statuses.at(-1), 'Waiting…');
  controller.stop();
});

test('snapshot populates position, turn, clock, and status', () => {
  const { factory, sync, controller, positions, turns, clocks, statuses } = setup('w');
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined', gameId: 'g1', role: 'white',
    state: stateView(0, 'w', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
  });
  assert.equal(positions.at(-1), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert.deepEqual(turns.at(-1), true); // white to move, we are white
  assert.deepEqual(clocks.at(-1), [60_000, 60_000]);
  assert.equal(statuses.at(-1), 'Your move');
  controller.stop();
  sync.stop();
});

test('move broadcast replays on top of snapshot FEN', () => {
  const { factory, sync, controller, positions } = setup('w');
  controller.start();
  sync.start();
  factory.last.open();
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', startFen) });

  // White plays e4 (UCI: e2e4)
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e2e4', san: 'e4', by: 'w',
    fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1,
  });

  // The controller should have projected the position after e2e4.
  // The FEN after 1.e4 should contain "e4" in the placement.
  const lastFen = positions.at(-1)!;
  assert.ok(lastFen.includes('e4'), `FEN should reflect e4 pawn push: ${lastFen}`);
  // Turn should now be black — not our turn.
  // (positions and turns arrays have entries from the snapshot + the move)
  controller.stop();
  sync.stop();
});

test('opponent move updates position and switches turn to our side', () => {
  const { factory, sync, controller, positions, turns } = setup('w');
  controller.start();
  sync.start();
  factory.last.open();
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', startFen) });

  // White plays e4
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e2e4', san: 'e4', by: 'w',
    fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1,
  });

  // Black plays e5 (UCI: e7e5)
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 2, uci: 'e7e5', san: 'e5', by: 'b',
    fenHash: 'h2', clock: { w: 59_000, b: 59_000 }, serverTs: 2,
  });

  const lastFen = positions.at(-1)!;
  assert.ok(lastFen.includes('e5'), `FEN should reflect e5 pawn push: ${lastFen}`);
  // After black's move, it's white's turn again — our turn.
  assert.deepEqual(turns.at(-1), true);
  controller.stop();
  sync.stop();
});

test('game ended emits checkmate status', () => {
  const { factory, sync, controller, statuses } = setup('w');
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', 'startpos') });
  factory.last.emit({
    t: 'ended', gameId: 'g1', result: '1-0', termination: 'checkmate', winner: 'w', serverTs: 5,
  });
  assert.equal(statuses.at(-1), 'Checkmate — White wins (1-0)');
  controller.stop();
  sync.stop();
});

test('submitMove forwards to GameSync', () => {
  const { factory, sync, controller } = setup('w');
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', 'startpos') });

  const pending = controller.submitMove('e2e4');
  assert.deepEqual(pending, { uci: 'e2e4', clientSeq: 1 });
  // Verify the move was sent over the socket.
  const sent = JSON.parse(factory.last.sent.at(-1)!);
  assert.deepEqual(sent, { t: 'move', gameId: 'g1', uci: 'e2e4', clientSeq: 1 });
  controller.stop();
  sync.stop();
});

test('spectator (myColor=null) gets "White to move" not "Your move"', () => {
  const { factory, sync, controller, statuses } = setup(null);
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'spectator', state: stateView(0, 'w', 'startpos') });
  assert.equal(statuses.at(-1), 'White to move');
  controller.stop();
  sync.stop();
});

test('stop unsubscribes — no further callbacks after stop', () => {
  const { factory, sync, controller, positions } = setup('w');
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', 'startpos') });
  const countBefore = positions.length;
  controller.stop();
  // Emit another state change — should NOT produce a callback.
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e2e4', san: 'e4', by: 'w',
    fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1,
  });
  assert.equal(positions.length, countBefore, 'no callbacks after stop');
  sync.stop();
});

test('fen getter returns the last projected FEN', () => {
  const { factory, sync, controller } = setup('w');
  controller.start();
  sync.start();
  factory.last.open();
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', fen) });
  assert.equal(controller.fen, fen);
  controller.stop();
  sync.stop();
});
