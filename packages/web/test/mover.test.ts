import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMove, serializePlacement } from '../src/core/mover.js';
import { parsePlacement, STARTING_FEN } from '../src/core/position.js';

function placement(fen: string): string {
  return fen.split(' ')[0] ?? '';
}

test('serializePlacement round-trips the starting position', () => {
  const map = parsePlacement(STARTING_FEN);
  assert.equal(serializePlacement(map), placement(STARTING_FEN));
});

test('normal pawn move updates placement and flips side', () => {
  const out = applyMove(STARTING_FEN, { from: 'e2', to: 'e4' });
  assert.equal(placement(out), 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR');
  assert.equal(out.split(' ')[1], 'b');
});

test('capture removes the target piece', () => {
  const fen = 'rnbqkbnr/pppp1ppp/8/4p3/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 1';
  const out = applyMove(fen, { from: 'd4', to: 'e5' });
  const map = parsePlacement(out);
  assert.deepEqual(map.get('e5'), { color: 'w', role: 'p' });
  assert.equal(map.get('d4'), undefined);
});

test('promotion replaces the pawn with the chosen piece', () => {
  const out = applyMove('4k3/4P3/8/8/8/8/8/4K3 w - - 0 1', { from: 'e7', to: 'e8', promotion: 'q' });
  assert.deepEqual(parsePlacement(out).get('e8'), { color: 'w', role: 'q' });
});

test('kingside castling transfers the rook', () => {
  const fen = '4k3/8/8/8/8/8/8/4K2R w K - 0 1';
  const out = applyMove(fen, { from: 'e1', to: 'g1' });
  const map = parsePlacement(out);
  assert.deepEqual(map.get('g1'), { color: 'w', role: 'k' });
  assert.deepEqual(map.get('f1'), { color: 'w', role: 'r' });
  assert.equal(map.get('h1'), undefined);
});

test('queenside castling transfers the rook', () => {
  const fen = '4k3/8/8/8/8/8/8/R3K3 w Q - 0 1';
  const out = applyMove(fen, { from: 'e1', to: 'c1' });
  const map = parsePlacement(out);
  assert.deepEqual(map.get('c1'), { color: 'w', role: 'k' });
  assert.deepEqual(map.get('d1'), { color: 'w', role: 'r' });
  assert.equal(map.get('a1'), undefined);
});

test('en-passant capture removes the passed pawn', () => {
  // White pawn d5, black pawn just moved e7-e5; white plays dxe6 e.p.
  const fen = '4k3/8/8/3Pp3/8/8/8/4K3 w - e6 0 1';
  const out = applyMove(fen, { from: 'd5', to: 'e6' });
  const map = parsePlacement(out);
  assert.deepEqual(map.get('e6'), { color: 'w', role: 'p' });
  assert.equal(map.get('e5'), undefined); // captured en passant
  assert.equal(map.get('d5'), undefined);
});

test('applyMove is a no-op when the from-square is empty', () => {
  const out = applyMove(STARTING_FEN, { from: 'e4', to: 'e5' });
  assert.equal(placement(out), placement(STARTING_FEN));
});
