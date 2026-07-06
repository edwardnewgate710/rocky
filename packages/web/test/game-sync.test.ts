import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WsClient } from '../src/net/ws-client.js';
import { GameSync } from '../src/net/game-sync.js';
import { AuthoritativeMoveOracle } from '../src/net/authoritative-oracle.js';
import type { LegalMoves, StateView, WsColor } from '../src/net/ws-protocol.js';
import { FakeSocketFactory, ManualScheduler } from './support/fake-socket.js';

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
  const sync = new GameSync(client, { gameId: 'g1', userId: 'u1' });
  return { factory, scheduler, client, sync };
}

function stateView(
  ply: number,
  turn: WsColor,
  moves: StateView['moves'] = [],
  legalMoves: LegalMoves = {},
): StateView {
  return {
    gameId: 'g1',
    variant: 'standard',
    players: { white: 'u1', black: 'u2' },
    timeControl: { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    fen: 'startpos',
    fenHash: `h${ply}`,
    ply,
    turn,
    clock: { w: 60_000, b: 60_000 },
    status: { over: false },
    drawOffer: null,
    moves,
    legalMoves,
  };
}

test('start joins on open', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  assert.deepEqual(JSON.parse(factory.last.sent[0]!), { t: 'join', gameId: 'g1', userId: 'u1' });
  assert.equal(sync.getState().connected, true);
});

test('joined populates role, color and snapshot', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });
  const s = sync.getState();
  assert.equal(s.role, 'white');
  assert.equal(s.myColor, 'w');
  assert.equal(s.ply, 0);
  assert.equal(s.turn, 'w');
  assert.equal(s.snapshot?.fen, 'startpos');
});

test('submitMove sends an incrementing clientSeq and a matching broadcast confirms it', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });

  const pending = sync.submitMove('e2e4');
  assert.deepEqual(pending, { uci: 'e2e4', clientSeq: 1 });
  const sent = JSON.parse(factory.last.sent.at(-1)!);
  assert.deepEqual(sent, { t: 'move', gameId: 'g1', uci: 'e2e4', clientSeq: 1 });
  assert.deepEqual(sync.getState().pending, { uci: 'e2e4', clientSeq: 1 });

  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e2e4', san: 'e4', by: 'w',
    fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1,
  });
  const s = sync.getState();
  assert.equal(s.pending, null);
  assert.equal(s.ply, 1);
  assert.equal(s.turn, 'b');
  assert.equal(s.moves.length, 1);
  assert.deepEqual(s.clock, { w: 59_000, b: 60_000 });
});

test('a reject rolls back the pending move and records the reason', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });
  sync.submitMove('e2e4');
  factory.last.emit({ t: 'reject', gameId: 'g1', ref: 1, code: 'illegal_move', message: 'nope' });
  const s = sync.getState();
  assert.equal(s.pending, null);
  assert.equal(s.lastReject?.code, 'illegal_move');
});

test('an opponent move applies; a ply gap triggers a resume request', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });

  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e7e5', san: 'e5', by: 'b',
    fenHash: 'h1', clock: { w: 60_000, b: 59_000 }, serverTs: 1,
  });
  assert.equal(sync.getState().ply, 1);

  const before = factory.last.sent.length;
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 3, uci: 'g1f3', san: 'Nf3', by: 'w',
    fenHash: 'h3', clock: { w: 59_000, b: 59_000 }, serverTs: 2,
  });
  assert.equal(sync.getState().ply, 1); // gap not applied
  assert.deepEqual(JSON.parse(factory.last.sent.at(-1)!), { t: 'resume', gameId: 'g1', lastPly: 1 });
  assert.equal(factory.last.sent.length, before + 1);
});

test('ended and presence update state', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });
  factory.last.emit({ t: 'presence', gameId: 'g1', white: true, black: true, spectators: 4 });
  factory.last.emit({ t: 'ended', gameId: 'g1', result: '1-0', termination: 'checkmate', winner: 'w', serverTs: 5 });
  const s = sync.getState();
  assert.deepEqual(s.presence, { white: true, black: true, spectators: 4 });
  assert.deepEqual(s.status, { over: true, result: '1-0', termination: 'checkmate', winner: 'w' });
});

test('after an unexpected drop, reconnect resumes from the last ply', () => {
  const { factory, scheduler, sync } = setup();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e7e5', san: 'e5', by: 'b',
    fenHash: 'h1', clock: { w: 60_000, b: 59_000 }, serverTs: 1,
  });
  assert.equal(sync.getState().ply, 1);

  factory.last.serverClose(1006, '', false);
  scheduler.runNext(); // reconnect opens socket #2
  factory.last.open();
  assert.deepEqual(JSON.parse(factory.last.sent[0]!), { t: 'resume', gameId: 'g1', lastPly: 1 });
});

test('stop closes the connection and marks disconnected', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  assert.equal(sync.getState().connected, true);
  sync.stop();
  assert.equal(sync.getState().connected, false);
  assert.ok(factory.last.closed);
});

// ── legalMoves surfacing (increment 3C-2B) ──────────────────────────────

test('legalMoves defaults to empty before a snapshot', () => {
  const { sync } = setup();
  assert.deepEqual(sync.getState().legalMoves, {});
});

test('legalMoves are populated from the authoritative snapshot', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  const lm: LegalMoves = { e2: ['e3', 'e4'], g1: ['f3', 'h3'] };
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', [], lm) });
  assert.deepEqual(sync.getState().legalMoves, lm);
});

test('legalMoves go stale (empty) after a live move broadcast', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  const lm: LegalMoves = { e2: ['e3', 'e4'] };
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', [], lm) });
  assert.deepEqual(sync.getState().legalMoves, lm);

  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e2e4', san: 'e4', by: 'w',
    fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1,
  });
  assert.deepEqual(sync.getState().legalMoves, {});
});

test('legalMoves are cleared when the game ends', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  const lm: LegalMoves = { e2: ['e3', 'e4'] };
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', [], lm) });
  assert.deepEqual(sync.getState().legalMoves, lm);

  factory.last.emit({ t: 'ended', gameId: 'g1', result: '1-0', termination: 'checkmate', winner: 'w', serverTs: 5 });
  assert.deepEqual(sync.getState().legalMoves, {});
});

test('legalMoves are refreshed by a resync snapshot', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', [], { e2: ['e3', 'e4'] }) });
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e2e4', san: 'e4', by: 'w',
    fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1,
  });
  assert.deepEqual(sync.getState().legalMoves, {});

  // Server sends a fresh snapshot (e.g. after a resync)
  const lm: LegalMoves = { e7: ['e6', 'e5'] };
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(1, 'b', [], lm) });
  assert.deepEqual(sync.getState().legalMoves, lm);
});

// ── AuthoritativeMoveOracle adapter (increment 3C-2B) ───────────────────

test('AuthoritativeMoveOracle returns destinations from GameSync legalMoves', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  const lm: LegalMoves = { e2: ['e3', 'e4'], g1: ['f3', 'h3'] };
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', [], lm) });

  const oracle = new AuthoritativeMoveOracle({ getLegalMoves: () => sync.getState().legalMoves });
  oracle.setPosition('startpos');
  assert.deepEqual([...oracle.destinations('e2')], ['e3', 'e4']);
  assert.deepEqual([...oracle.destinations('g1')], ['f3', 'h3']);
});

test('AuthoritativeMoveOracle returns empty for unknown squares', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', [], { e2: ['e3'] }) });

  const oracle = new AuthoritativeMoveOracle({ getLegalMoves: () => sync.getState().legalMoves });
  assert.deepEqual([...oracle.destinations('a1')], []);
});

test('AuthoritativeMoveOracle returns empty when legalMoves are stale after a move', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', [], { e2: ['e3', 'e4'] }) });

  const oracle = new AuthoritativeMoveOracle({ getLegalMoves: () => sync.getState().legalMoves });
  assert.deepEqual([...oracle.destinations('e2')], ['e3', 'e4']);

  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e2e4', san: 'e4', by: 'w',
    fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1,
  });
  assert.deepEqual([...oracle.destinations('e2')], []);
});

test('AuthoritativeMoveOracle returns empty when game is over', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', [], { e2: ['e3'] }) });

  const oracle = new AuthoritativeMoveOracle({ getLegalMoves: () => sync.getState().legalMoves });
  factory.last.emit({ t: 'ended', gameId: 'g1', result: '1-0', termination: 'checkmate', winner: 'w', serverTs: 5 });
  assert.deepEqual([...oracle.destinations('e2')], []);
});
