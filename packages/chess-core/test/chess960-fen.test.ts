/**
 * The castling field, in both spellings.
 *
 * A four-bit mask cannot say which rook holds a right, so `HAha` used to parse to nothing at all:
 * the letters fell through a `default: break` and the position silently lost every castling right
 * it had. It was not merely dropped on output — kiwipete with `HAha` generated 46 moves against 48
 * with `KQkq`, so the loss changed the game.
 *
 * Rights are now the file of the rook that carries them, which is what both spellings encode:
 *
 *   - Shredder-FEN names the file outright (`HAha`);
 *   - X-FEN keeps `KQkq`, meaning the *outermost* rook on that side.
 *
 * Reading both matters because the published Chess960 corpora are written in Shredder-FEN while
 * every ordinary FEN in the world is written the other way.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Position } from '../src/position';
import { CHESS960_POSITIONS } from '../src/chess960';

const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w';
const castlingField = (pos: Position): string => pos.fen().split(' ')[2];

test('the defect: file-letter rights used to be discarded, changing the legal moves', () => {
  const withLetters = Position.fromFen(`${KIWIPETE} HAha - 0 1`, 'chess960');
  const withKQkq = Position.fromFen(`${KIWIPETE} KQkq - 0 1`, 'chess960');
  const withNothing = Position.fromFen(`${KIWIPETE} - - 0 1`, 'chess960');

  assert.equal(withLetters.perft(1), 48, 'HAha must grant the same four rights KQkq does');
  assert.equal(withKQkq.perft(1), 48);
  assert.equal(withNothing.perft(1), 46, 'and having no rights really is two moves fewer');
});

test('both spellings of the same rights produce the same position', () => {
  const fromLetters = Position.fromFen(`${KIWIPETE} HAha - 0 1`, 'chess960');
  const fromKQkq = Position.fromFen(`${KIWIPETE} KQkq - 0 1`, 'chess960');
  assert.equal(fromLetters.fen(), fromKQkq.fen());
});

test('a partial right in either spelling grants exactly that right', () => {
  const cases: readonly [string, string][] = [
    ['H', 'K'],
    ['A', 'Q'],
    ['h', 'k'],
    ['a', 'q'],
    ['HA', 'KQ'],
    ['ha', 'kq'],
    ['Ha', 'Kq'],
    ['K', 'K'],
    ['Qq', 'Qq'],
  ];
  for (const [written, canonical] of cases) {
    const pos = Position.fromFen(`${KIWIPETE} ${written} - 0 1`, 'chess960');
    assert.equal(castlingField(pos), canonical, `"${written}" should canonicalise to "${canonical}"`);
  }
});

test('a right naming a rook that is not there is dropped rather than believed', () => {
  // `B` claims a white rook on b1; kiwipete has none. Keeping the right would leave move generation
  // pointing at an empty square.
  //
  // Asserted on its own, not only alongside a valid right. With `BA` the surviving `A` overwrites
  // the queenside slot and the field prints `Q` either way, so a parser that believed `B` would look
  // exactly like one that discarded it.
  assert.equal(castlingField(Position.fromFen(`${KIWIPETE} B - 0 1`, 'chess960')), '-');
  assert.equal(castlingField(Position.fromFen(`${KIWIPETE} BA - 0 1`, 'chess960')), 'Q');
});

test('an inner rook is spelled by file, because KQkq cannot say which rook is meant', () => {
  // Two white rooks on the kingside: a1, f1 and h1, king on e1. The right belongs to f1, the inner
  // one. X-FEN must not write that as `K`, which by definition means the outermost rook — h1.
  const pos = Position.fromFen('4k3/8/8/8/8/8/8/R3KR1R w FA - 0 1', 'chess960');
  assert.equal(castlingField(pos), 'FQ');

  // The same board with the right on the outermost rook does spell `K`.
  const outer = Position.fromFen('4k3/8/8/8/8/8/8/R3KR1R w HA - 0 1', 'chess960');
  assert.equal(castlingField(outer), 'KQ');
});

test('KQkq resolves to the outermost rook when there is more than one candidate', () => {
  // `K` on a board with white rooks on f1 and h1 must pick h1 — the outermost — so it re-serialises
  // as `K`, not `F`.
  const kingside = Position.fromFen('4k3/8/8/8/8/8/8/R3KR1R w K - 0 1', 'chess960');
  assert.equal(castlingField(kingside), 'K');

  // The queenside is a separate branch and picks the other end of the list: with white rooks on a1
  // and c1, `Q` must mean a1. Choosing c1 would still re-serialise as `Q` — c1 is not outermost, so
  // it would be written `C` — which is what makes this cheap to get wrong and invisible without a
  // second rook on the queenside to tell the two ends apart.
  const queenside = Position.fromFen('4k3/8/8/8/8/8/8/R1R1K2R w Q - 0 1', 'chess960');
  assert.equal(castlingField(queenside), 'Q');

  // And naming the inner queenside rook explicitly must survive as a file letter.
  const innerQueenside = Position.fromFen('4k3/8/8/8/8/8/8/R1R1K2R w C - 0 1', 'chess960');
  assert.equal(castlingField(innerQueenside), 'C');
});

test('every one of the 960 starting positions survives a FEN round trip', () => {
  for (let id = 0; id < CHESS960_POSITIONS; id++) {
    const original = Position.chess960(id);
    const reparsed = Position.fromFen(original.fen(), 'chess960');
    assert.equal(reparsed.fen(), original.fen(), `id ${id} does not round-trip`);
    assert.equal(
      reparsed.legalMoves().length,
      original.legalMoves().length,
      `id ${id} loses moves on the round trip`,
    );
  }
});

test('the spelling of a right tracks the board, while the right itself does not move', () => {
  // White's kingside right belongs to the inner rook on f1, so it needs a file letter while the
  // rook on h1 stands outside it. Move that h1 rook — which holds no right at all — and f1 becomes
  // the outermost kingside rook, so the very same right is now spelled `K`.
  //
  // This is the property that makes X-FEN output worth testing rather than assuming: the letter is
  // a function of the position, not a stored value, and it has to stay a faithful description of a
  // right that never changed hands.
  let pos = Position.fromFen('r3k2r/8/8/8/8/8/8/R3KR1R w FAha - 0 1', 'chess960');
  assert.equal(castlingField(pos), 'FQkq');

  pos = pos.play('h1h4');
  assert.equal(castlingField(pos), 'KQkq', 'f1 is now the outermost kingside rook');

  const reparsed = Position.fromFen(pos.fen(), 'chess960');
  assert.equal(reparsed.fen(), pos.fen(), 'and the new spelling parses back to the same position');
  assert.equal(
    reparsed.legalMoves().length,
    pos.legalMoves().length,
    'the right still belongs to f1, so the same castle is still available',
  );
});

test('standard chess spells its castling field exactly as it always has', () => {
  // The whole reason X-FEN was chosen over Shredder-FEN for output: ordinary positions must keep
  // ordinary FENs. Rooks on a and h are always outermost, so `KQkq` is the only possible spelling.
  const cases: readonly string[] = [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
    'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
  ];
  for (const fen of cases) {
    assert.equal(Position.fromFen(fen, 'standard').fen(), fen, fen);
  }
});

test('the standard start position is byte-identical under both rule sets', () => {
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  assert.equal(Position.fromFen(fen, 'standard').fen(), fen);
  assert.equal(Position.fromFen(fen, 'chess960').fen(), fen);
});

test('no castling rights serialises as a single dash', () => {
  const pos = Position.fromFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'chess960');
  assert.equal(castlingField(pos), '-');
});
