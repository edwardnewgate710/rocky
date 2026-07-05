import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardInteraction } from '../src/core/interaction.js';
import { StaticMoveOracle } from '../src/ports/move-oracle.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const START_BLACK = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1';
// White pawn on e7, white to move (promotion available).
const PROMO_W = '4k3/4P3/8/8/8/8/8/4K3 w - - 0 1';
// Same pieces, black to move (used for premove-promotion by white).
const PROMO_B = '4k3/4P3/8/8/8/8/8/4K3 b - - 0 1';

function startOracle(): StaticMoveOracle {
  return new StaticMoveOracle({
    [START]: { e2: ['e3', 'e4'], g1: ['f3', 'h3'], d2: ['d3', 'd4'] },
    [PROMO_W]: { e7: ['e8'] },
    [PROMO_B]: { e7: ['e8'] },
  });
}

function make(fen: string, opts: Partial<{ myTurn: boolean; playerColor: 'white' | 'black' }> = {}) {
  const bi = new BoardInteraction({
    oracle: startOracle(),
    ...(opts.playerColor ? { playerColor: opts.playerColor } : {}),
    ...(opts.myTurn !== undefined ? { myTurn: opts.myTurn } : {}),
  });
  bi.setPosition(fen);
  return bi;
}

// ---- selection & click-to-move ----

test('selecting an own piece exposes legal destinations', () => {
  const bi = make(START);
  const r = bi.tap('e2');
  assert.equal(r.kind, 'select');
  assert.deepEqual([...bi.highlights().legal], ['e3', 'e4']);
  assert.equal(bi.highlights().selected, 'e2');
});

test('tapping empty square with nothing selected does nothing', () => {
  const bi = make(START);
  assert.equal(bi.tap('e4').kind, 'none');
});

test('cannot select an opponent piece', () => {
  const bi = make(START);
  assert.equal(bi.tap('e7').kind, 'none');
  assert.equal(bi.highlights().selected, null);
});

test('click-to-move to a legal square emits a move and clears selection', () => {
  const bi = make(START);
  bi.tap('e2');
  const r = bi.tap('e4');
  assert.deepEqual(r, { kind: 'move', move: { from: 'e2', to: 'e4' } });
  assert.equal(bi.highlights().selected, null);
});

test('tapping the selected square again deselects', () => {
  const bi = make(START);
  bi.tap('e2');
  assert.equal(bi.tap('e2').kind, 'deselect');
  assert.equal(bi.highlights().selected, null);
});

test('tapping another own piece reselects it', () => {
  const bi = make(START);
  bi.tap('e2');
  const r = bi.tap('g1');
  assert.equal(r.kind, 'select');
  assert.deepEqual([...bi.highlights().legal], ['f3', 'h3']);
});

test('tapping an illegal empty square deselects', () => {
  const bi = make(START);
  bi.tap('e2');
  assert.equal(bi.tap('e5').kind, 'deselect');
  assert.equal(bi.highlights().selected, null);
});

// ---- drag & drop ----

test('drag & drop to a legal square emits a move', () => {
  const bi = make(START);
  assert.equal(bi.dragStart('e2').kind, 'select');
  assert.deepEqual(bi.drop('e2', 'e4'), { kind: 'move', move: { from: 'e2', to: 'e4' } });
});

test('drag & drop to an illegal square deselects, no move', () => {
  const bi = make(START);
  bi.dragStart('e2');
  assert.equal(bi.drop('e2', 'e5').kind, 'deselect');
});

test('drop onto the same square deselects', () => {
  const bi = make(START);
  bi.dragStart('e2');
  assert.equal(bi.drop('e2', 'e2').kind, 'deselect');
});

test('cannot start a drag on an opponent piece', () => {
  const bi = make(START);
  assert.equal(bi.dragStart('e7').kind, 'none');
});

// ---- promotion ----

test('promotion move requires a role then emits the promotion move', () => {
  const bi = make(PROMO_W);
  bi.tap('e7');
  const r = bi.tap('e8');
  assert.deepEqual(r, { kind: 'promotion', from: 'e7', to: 'e8', premove: false });
  assert.equal(bi.awaitingPromotion, true);
  // Gestures are ignored while a promotion is pending.
  assert.equal(bi.tap('a1').kind, 'none');
  const done = bi.resolvePromotion('q');
  assert.deepEqual(done, { kind: 'move', move: { from: 'e7', to: 'e8', promotion: 'q' } });
  assert.equal(bi.awaitingPromotion, false);
});

test('cancelling a promotion clears the pending state', () => {
  const bi = make(PROMO_W);
  bi.tap('e7');
  bi.tap('e8');
  bi.cancelPromotion();
  assert.equal(bi.awaitingPromotion, false);
  assert.equal(bi.highlights().selected, null);
});

// ---- premoves ----

test('when it is not our turn a move is queued as a premove', () => {
  const bi = make(START_BLACK, { myTurn: false, playerColor: 'white' });
  const sel = bi.tap('e2');
  assert.equal(sel.kind, 'select');
  assert.deepEqual([...bi.highlights().legal], []); // no legal preview off-turn
  const r = bi.tap('e4');
  assert.deepEqual(r, { kind: 'premove', premove: { from: 'e2', to: 'e4' } });
  assert.equal(bi.hasPremove, true);
  assert.deepEqual([...bi.highlights().premove], ['e2', 'e4']);
});

test('a premove cannot capture our own piece', () => {
  const bi = make(START_BLACK, { myTurn: false, playerColor: 'white' });
  bi.tap('e2');
  assert.equal(bi.tap('d2').kind, 'select'); // d2 is own -> reselect, not premove-capture
  assert.equal(bi.hasPremove, false);
});

test('premove promotion queues a promotion premove', () => {
  const bi = make(PROMO_B, { myTurn: false, playerColor: 'white' });
  bi.tap('e7');
  const r = bi.tap('e8');
  assert.deepEqual(r, { kind: 'promotion', from: 'e7', to: 'e8', premove: true });
  const done = bi.resolvePromotion('n');
  assert.deepEqual(done, { kind: 'premove', premove: { from: 'e7', to: 'e8', promotion: 'n' } });
  assert.equal(bi.hasPremove, true);
});

test('applyPremove plays a still-legal premove when the turn arrives', () => {
  const bi = make(START_BLACK, { myTurn: false, playerColor: 'white' });
  bi.tap('e2');
  bi.tap('e4');
  // Opponent moved; now our turn, oracle still lists e2->e4 (START position).
  bi.setPosition(START);
  bi.setTurn(true);
  const r = bi.applyPremove();
  assert.deepEqual(r, { kind: 'move', move: { from: 'e2', to: 'e4' } });
  assert.equal(bi.hasPremove, false);
});

test('applyPremove discards a premove that is no longer legal', () => {
  const bi = make(START_BLACK, { myTurn: false, playerColor: 'white' });
  bi.tap('e2');
  bi.tap('a1'); // queue an implausible premove not in the oracle for START
  bi.setPosition(START);
  bi.setTurn(true);
  const r = bi.applyPremove();
  assert.equal(r.kind, 'none');
  assert.equal(bi.hasPremove, false);
});

test('applyPremove is a no-op when it is not our turn', () => {
  const bi = make(START_BLACK, { myTurn: false, playerColor: 'white' });
  bi.tap('e2');
  bi.tap('e4');
  assert.equal(bi.applyPremove().kind, 'none');
  assert.equal(bi.hasPremove, true);
});

// ---- last move highlight ----

test('setLastMove surfaces in highlights', () => {
  const bi = make(START);
  bi.setLastMove('g1', 'f3');
  assert.deepEqual(bi.highlights().lastMove, ['g1', 'f3']);
});

test('setPosition clears selection but gestures resume afterwards', () => {
  const bi = make(START);
  bi.tap('e2');
  bi.setPosition(START);
  assert.equal(bi.highlights().selected, null);
  assert.equal(bi.tap('d2').kind, 'select');
});
