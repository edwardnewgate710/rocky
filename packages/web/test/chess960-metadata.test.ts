import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WsClient } from '../src/net/ws-client.js';
import { GameSync } from '../src/net/game-sync.js';
import { GameController, type GameMetadataState } from '../src/app/game-controller.js';
import type { StateView, WsColor } from '../src/net/ws-protocol.js';
import { FakeSocketFactory, ManualScheduler } from './support/fake-socket.js';

/**
 * The starting-position id reaching the client, and surviving a reconnect.
 *
 * The reconnect half is the point. A client learns the id from the authoritative snapshot, and a
 * reconnect delivers a *fresh* snapshot — so the failure worth catching is a game that comes back
 * from a dropped socket describing itself as a different arrangement, or as none. ADR-0137.
 */

const SP700_FEN = 'rbqknnbr/pppppppp/8/8/8/8/PPPPPPPP/RBQKNNBR w KQkq - 0 1';

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
  const sync = new GameSync(client, { gameId: 'g1', token: 'token-u1' });
  const metadatas: GameMetadataState[] = [];
  const controller = new GameController({
    gameSync: sync,
    callbacks: {
      onPosition: () => {},
      onTurn: () => {},
      onClock: () => {},
      onStatus: () => {},
      onMetadata: (m) => { metadatas.push(m); },
    },
  });
  return { factory, scheduler, sync, controller, metadatas };
}

function stateView(
  variant: StateView['variant'],
  fen: string,
  chess960StartId: number | null,
  ply = 0,
  turn: WsColor = 'w',
): StateView {
  return {
    gameId: 'g1',
    variant,
    players: { white: 'u1', black: 'u2' },
    timeControl: { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    fen,
    fenHash: `h${ply}`,
    ply,
    turn,
    clock: { w: 60_000, b: 60_000 },
    turnStartedAt: null,
    status: { over: false },
    drawOffer: null,
    moves: [],
    legalMoves: {},
    chess960StartId,
  };
}

test('the starting-position id arrives with the snapshot', () => {
  const { factory, sync, controller, metadatas } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined', gameId: 'g1', role: 'white',
    state: stateView('chess960', SP700_FEN, 700),
  });

  assert.equal(metadatas.at(-1)?.variant, 'chess960');
  assert.equal(metadatas.at(-1)?.chess960StartId, 700);
  controller.stop();
  sync.stop();
});

test('every other variant reports no starting position', () => {
  const { factory, sync, controller, metadatas } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined', gameId: 'g1', role: 'white',
    state: stateView('standard', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', null),
  });

  assert.equal(metadatas.at(-1)?.chess960StartId, null);
  controller.stop();
  sync.stop();
});

test('a resync snapshot reports the same arrangement', () => {
  // A reconnect re-delivers state. The board comes from `fen` and the identity from the id, and both
  // have to still describe the game that was being played.
  const { factory, sync, controller, metadatas } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined', gameId: 'g1', role: 'white',
    state: stateView('chess960', SP700_FEN, 700),
  });
  assert.equal(metadatas.at(-1)?.chess960StartId, 700);

  // The game has moved on, and the fresh snapshot carries the current position — but the same start.
  const movedOn = 'rbqknnbr/pppppp1p/6p1/8/4P3/8/PPPP1PPP/RBQKNNBR w KQkq - 0 2';
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView('chess960', movedOn, 700, 2) });

  assert.equal(
    metadatas.at(-1)?.chess960StartId,
    700,
    'the arrangement the game began from does not change when the board does',
  );
  controller.stop();
  sync.stop();
});

test('a changed starting-position id is reported rather than swallowed', () => {
  // Metadata callbacks only fire when something changed, and the id had to be added to that
  // comparison. Without it a client would keep displaying the first game's arrangement — which is a
  // stale-state bug that no board rendering would reveal, since the FEN would be right.
  const { factory, sync, controller, metadatas } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined', gameId: 'g1', role: 'white',
    state: stateView('chess960', SP700_FEN, 700),
  });
  const countBefore = metadatas.length;

  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView('chess960', SP700_FEN, 701) });

  assert.ok(metadatas.length > countBefore, 'the change produced a metadata update');
  assert.equal(metadatas.at(-1)?.chess960StartId, 701);
  controller.stop();
  sync.stop();
});
