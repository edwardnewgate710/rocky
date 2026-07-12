/**
 * End-to-end live gameplay loop test (C1 standing rule, Review #02 rewrite).
 *
 * This is the "immune system" test. It plays at least two full moves through
 * the full client stack: GameSync ⇄ AuthoritativeMoveOracle ⇄ BoardInteraction,
 * driven by a **real `GameAuthority`** from `@chess-platform/realtime-gateway`
 * so that legal-move maps are computed by the perft-verified engine, not
 * hand-written fixtures.
 *
 * The authority's broadcasts are bridged through the JSON codec → GameSync,
 * exercising the wire mirror too. Both legs (two full moves + resume) are kept.
 *
 * The realtime-gateway is a **test-only** devDependency; ADR-0003's no-core-in-web
 * guardrail governs the production bundle, not tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WsClient } from '../src/net/ws-client.js';
import { GameSync } from '../src/net/game-sync.js';
import { AuthoritativeMoveOracle } from '../src/net/authoritative-oracle.js';
import { BoardInteraction } from '../src/core/interaction.js';
import { FakeSocketFactory, ManualScheduler } from './support/fake-socket.js';

// Test-only import from realtime-gateway — NOT in the production bundle.
import {
  GameAuthority,
  InMemoryPubSub,
  encode,
  type ServerMessage,
  type Broadcast,
  type TokenVerifier,
} from '@chess-platform/realtime-gateway';

/** A trivial TokenVerifier that maps tokens to user ids for the e2e test. */
const e2eVerifier: TokenVerifier = {
  verify(token: string): { readonly userId: string } | null {
    if (token === 'token-alice') return { userId: 'alice' };
    if (token === 'token-bob') return { userId: 'bob' };
    return null;
  },
};

const TC = { initialMs: 300_000, incrementMs: 3_000, delayMs: 0, kind: 'increment' as const };

/**
 * Bridge: a real GameAuthority + PubSub that simulates the server side.
 * Broadcasts are encoded to JSON and then decoded by the GameSync's wire
 * mirror, so the full codec path is exercised.
 */
async function createAuthority() {
  const pubsub = new InMemoryPubSub();
  let clock = 1_000;
  const now = () => (clock += 10);
  const authority = new GameAuthority(pubsub, now);
  await authority.createGame({
    gameId: 'g1',
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: false,
  });
  return { authority, pubsub, now };
}

function setupClient(token: string) {
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
  const sync = new GameSync(client, { gameId: 'g1', token });
  return { factory, scheduler, client, sync };
}

/** Flush microtasks so async authority.apply completes. */
const flush = () => new Promise((r) => setImmediate(r));

test('R2#4 e2e: two-move live loop driven by real GameAuthority', async () => {
  const { authority, pubsub } = await createAuthority();
  const { factory, sync } = setupClient('token-alice');

  // Wire up the full client stack.
  const oracle = new AuthoritativeMoveOracle({
    getLegalMoves: () => sync.getState().legalMoves,
  });
  const interaction = new BoardInteraction({ oracle, myTurn: true });

  // Subscribe to authority broadcasts → encode → deliver to the fake socket.
  pubsub.subscribe('game:g1', (msg: Broadcast) => {
    const frame = encode(msg as ServerMessage);
    const decoded = JSON.parse(frame);
    factory.last.emit(decoded);
  });

  // Start the sync and open the connection.
  sync.start();
  factory.last.open();

  // --- Simulate the gateway's join response ---
  // The authority's getState gives us the real starting position + legal moves.
  const initialState = authority.getState('g1');
  factory.last.emit({
    t: 'joined', gameId: 'g1', role: 'white', state: initialState,
  });

  // Sync the interaction to the current position.
  interaction.setPosition(sync.getState().snapshot!.fen);
  interaction.setTurn(true); // White to move, we are White.

  // --- Move 1: White plays e4 ---
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

  // Apply the move on the real authority — this computes real legal moves
  // and publishes a real MoveBroadcast through the pubsub bridge.
  await authority.apply('g1', 'alice', { kind: 'move', uci: 'e2e4' });
  await flush();

  // After the broadcast, it's Black's turn.
  assert.equal(sync.getState().turn, 'b');
  assert.equal(sync.getState().myColor, 'w');
  interaction.setPosition(sync.getState().snapshot!.fen);
  // The position should have advanced — replay the move on the snapshot FEN.
  // Actually, the snapshot FEN is from the initial join; we need to update
  // the interaction's position from the controller's projection. For this
  // test we set it from the broadcast's implied position by replaying.
  // The simplest approach: use the authority's current FEN.
  interaction.setPosition(authority.getState('g1').fen);
  interaction.setTurn(false); // Not our turn.

  // --- Simulate opponent's move (e5) via real authority ---
  await authority.apply('g1', 'bob', { kind: 'move', uci: 'e7e5' });
  await flush();

  // Now it's White's turn again. The oracle should have fresh legal moves
  // from the real authority's broadcast.
  assert.equal(sync.getState().turn, 'w');
  interaction.setPosition(authority.getState('g1').fen);
  interaction.setTurn(true);

  // --- Move 2: White plays Nf3 (g1-f3) ---
  // This is the critical assertion: after a live broadcast from the real
  // authority, the oracle must still provide destinations. Before the C1
  // fix, legalMoves would have been wiped to {} and this would fail.
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

  // Apply on the real authority to confirm it's legal.
  await authority.apply('g1', 'alice', { kind: 'move', uci: 'g1f3' });
  await flush();

  // The authority should now be at ply 3.
  assert.equal(authority.getState('g1').ply, 3);

  sync.stop();
});

test('R2#4 e2e: resume after disconnect with real GameAuthority', async () => {
  const { authority, pubsub } = await createAuthority();
  const { factory, sync } = setupClient('token-alice');
  const oracle = new AuthoritativeMoveOracle({
    getLegalMoves: () => sync.getState().legalMoves,
  });

  pubsub.subscribe('game:g1', (msg: Broadcast) => {
    const frame = encode(msg as ServerMessage);
    factory.last.emit(JSON.parse(frame));
  });

  sync.start();
  factory.last.open();

  // Join.
  factory.last.emit({
    t: 'joined', gameId: 'g1', role: 'white', state: authority.getState('g1'),
  });

  // Play first move on the real authority.
  sync.submitMove('e2e4');
  await authority.apply('g1', 'alice', { kind: 'move', uci: 'e2e4' });
  await flush();

  // Simulate disconnect + reconnect.
  factory.last.close();
  factory.last.open();

  // Server sends resumed with current authoritative state.
  factory.last.emit({
    t: 'resumed', gameId: 'g1',
    state: authority.getState('g1'),
    missed: authority.getMissedSince('g1', 0),
  });

  // After resume, legalMoves should be populated from the real authority's snapshot.
  const lm = sync.getState().legalMoves;
  assert.ok(Object.keys(lm).length > 0, 'legalMoves should be populated after resume');

  // The oracle should work after resume — e7 should have e5/e6 as destinations
  // (real legal moves from the authority after 1.e4).
  oracle.setPosition(authority.getState('g1').fen);
  const dests = oracle.destinations('e7');
  assert.ok(dests.includes('e5'), 'e7 should have e5 as a legal destination after resume');
  assert.ok(dests.includes('e6'), 'e7 should have e6 as a legal destination after resume');

  sync.stop();
});
