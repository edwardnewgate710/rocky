import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/composition.js';
import { resolveConfig } from '../src/app/config.js';
import { GambitClient } from '../src/api/client.js';
import { WsClient } from '../src/net/ws-client.js';
import { GameSync } from '../src/net/game-sync.js';
import { AuthoritativeMoveOracle } from '../src/net/authoritative-oracle.js';
import { MemoryTokenStore } from '../src/net/session.js';
import type { KeyValueStorage } from '../src/net/session.js';
import { FakeTransport, json } from './support/fake-transport.js';
import { FakeSocketFactory } from './support/fake-socket.js';

const CONFIG = { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' } as const;

function make() {
  const transport = new FakeTransport().onEach(() => json(200, {}));
  const sockets = new FakeSocketFactory();
  const app = createApp({
    config: CONFIG,
    httpTransport: transport,
    wsFactory: sockets.factory,
    tokenStore: new MemoryTokenStore(),
  });
  return { app, transport, sockets };
}

test('createApp wires a GambitClient and a WsClient', () => {
  const { app } = make();
  assert.ok(app.api instanceof GambitClient);
  assert.ok(app.ws instanceof WsClient);
  assert.equal(app.config, CONFIG);
});

test('createApp opens no connection and makes no request on construction', () => {
  const { app, transport, sockets } = make();
  assert.equal(transport.calls.length, 0, 'no HTTP request should be sent while wiring');
  assert.equal(sockets.sockets.length, 0, 'no socket should be opened while wiring');
  assert.equal(app.ws.state, 'idle');
});

test('disposing the app closes its owned realtime connection', () => {
  const { app, sockets } = make();
  const sync = app.createGameSync({ gameId: 'g1', token: 'token-u1' });
  sync.start();
  sockets.last.open();

  app.dispose();

  assert.deepEqual(sockets.last.closed, { code: 1000, reason: 'app-disposed' });
  assert.equal(app.ws.state, 'closed');
});

test('createGameSync builds a GameSync bound to the shared realtime client', () => {
  const { app } = make();
  const sync = app.createGameSync({ gameId: 'g1', token: 'token-u1' });
  assert.ok(sync instanceof GameSync);
  const state = sync.getState();
  assert.equal(state.gameId, 'g1');
  assert.equal(state.connected, false);
});

test('createGameOracle returns an AuthoritativeMoveOracle reading from GameSync state', () => {
  const { app } = make();
  const sync = app.createGameSync({ gameId: 'g1', token: 'token-u1' });
  const oracle = app.createGameOracle(sync);
  assert.ok(oracle instanceof AuthoritativeMoveOracle);

  // Before any snapshot, legalMoves is empty — oracle returns no destinations.
  assert.deepEqual([...oracle.destinations('e2')], []);

  // Simulate a snapshot with legal moves by patching GameSync state.
  // We use the public API: start, open, emit a joined message.
  sync.start();
  // Access the fake socket to emit a joined message.
  // The FakeSocketFactory stores sockets; the last one is the one we need.
  // But we don't have direct access here — we test via the getter contract instead.
  // The oracle reads gameSync.getState().legalMoves; since no snapshot arrived,
  // it stays empty. This verifies the wiring (getter) is correct.
  sync.stop();
});

test('createGameOracle oracle reflects legalMoves from GameSync after a snapshot', () => {
  const { app, sockets } = make();
  const sync = app.createGameSync({ gameId: 'g1', token: 'token-u1' });
  const oracle = app.createGameOracle(sync);

  sync.start();
  sockets.last.open();
  sockets.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: {
      gameId: 'g1',
      variant: 'standard',
      players: { white: 'u1', black: 'u2' },
      timeControl: { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
      fen: 'startpos',
      fenHash: 'h0',
      ply: 0,
      turn: 'w',
      clock: { w: 60_000, b: 60_000 },
      status: { over: false },
      drawOffer: null,
      moves: [],
      legalMoves: { e2: ['e3', 'e4'], g1: ['f3', 'h3'] },
    },
  });

  // The oracle should now reflect the legal moves from the snapshot.
  assert.deepEqual([...oracle.destinations('e2')], ['e3', 'e4']);
  assert.deepEqual([...oracle.destinations('g1')], ['f3', 'h3']);
  assert.deepEqual([...oracle.destinations('a1')], []);

  sync.stop();
});

test('createApp injects the REST base URL into the client', async () => {
  const { app, transport } = make();
  await app.api.health();
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0]!.url, 'https://api.test/v1/health');
});

test('createApp falls back to a Web Storage session store when given a storage seam', () => {
  const backing = new Map<string, string>();
  const storage: KeyValueStorage = {
    getItem: (k) => backing.get(k) ?? null,
    setItem: (k, v) => {
      backing.set(k, v);
    },
    removeItem: (k) => {
      backing.delete(k);
    },
  };
  const app = createApp({
    config: CONFIG,
    httpTransport: new FakeTransport().onEach(() => json(200, {})),
    wsFactory: new FakeSocketFactory().factory,
    storage,
  });
  assert.equal(app.api.session.isAuthenticated, false);
});

test('resolveConfig derives same-origin REST and a scheme-matched socket', () => {
  assert.deepEqual(
    resolveConfig({ protocol: 'https:', host: 'gambit.test', origin: 'https://gambit.test' }),
    { apiBaseUrl: 'https://gambit.test', wsUrl: 'wss://gambit.test/ws' },
  );
  assert.deepEqual(
    resolveConfig({ protocol: 'http:', host: 'localhost:5173', origin: 'http://localhost:5173' }),
    { apiBaseUrl: 'http://localhost:5173', wsUrl: 'ws://localhost:5173/ws' },
  );
});
