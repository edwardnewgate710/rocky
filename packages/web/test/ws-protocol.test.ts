import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  colorForRole,
  decodeServer,
  encodeClient,
  opposite,
} from '../src/net/ws-protocol.js';
import type { ClientMessage } from '../src/net/ws-protocol.js';

test('encodeClient round-trips a client message', () => {
  const msg: ClientMessage = { t: 'move', gameId: 'g1', uci: 'e2e4', clientSeq: 7 };
  assert.deepEqual(JSON.parse(encodeClient(msg)), msg);
});

test('decodeServer parses each server message type', () => {
  const pong = decodeServer(JSON.stringify({ t: 'pong', ts: 1, serverTs: 2 }));
  assert.equal(pong?.t, 'pong');
  const presence = decodeServer(
    JSON.stringify({ t: 'presence', gameId: 'g', white: true, black: false, spectators: 3 }),
  );
  assert.equal(presence?.t, 'presence');
  const reject = decodeServer(
    JSON.stringify({ t: 'reject', gameId: 'g', ref: 4, code: 'illegal_move', message: 'no' }),
  );
  assert.equal(reject?.t, 'reject');
});

test('decodeServer preserves the authoritative legalMoves on a state frame', () => {
  const frame = decodeServer(
    JSON.stringify({
      t: 'state',
      gameId: 'g',
      state: { fen: 'startpos', turn: 'w', legalMoves: { e2: ['e3', 'e4'], g1: ['f3', 'h3'] } },
    }),
  );
  assert.equal(frame?.t, 'state');
  if (frame?.t === 'state') {
    assert.deepEqual(frame.state.legalMoves['e2'], ['e3', 'e4']);
    assert.deepEqual(frame.state.legalMoves['g1'], ['f3', 'h3']);
  }
});

test('decodeServer rejects malformed, non-object, and unknown/client frames', () => {
  assert.equal(decodeServer('{not json'), null);
  assert.equal(decodeServer('42'), null);
  assert.equal(decodeServer('null'), null);
  assert.equal(decodeServer(JSON.stringify({ t: 'nope' })), null);
  // A client-only message type is not a valid server frame.
  assert.equal(decodeServer(JSON.stringify({ t: 'join', gameId: 'g', userId: 'u' })), null);
});

test('opposite flips the side to move', () => {
  assert.equal(opposite('w'), 'b');
  assert.equal(opposite('b'), 'w');
});

test('colorForRole maps roles to wire colors', () => {
  assert.equal(colorForRole('white'), 'w');
  assert.equal(colorForRole('black'), 'b');
  assert.equal(colorForRole('spectator'), null);
});
