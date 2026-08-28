/**
 * Castling from arbitrary king and rook squares.
 *
 * The rule these tests exist for is that the *destinations* are fixed even though the *origins* are
 * not: whatever the arrangement, a castled king stands on g1/g8 or c1/c8 and its rook beside it on
 * f1/f8 or d1/d8. Everything that used to be a shortcut — the king starting on e, the rooks on a
 * and h, the king moving exactly two squares — is a coincidence of the traditional array and is
 * false in general.
 *
 * Positions here park the Black king on a5 (or elsewhere off the back rank) so that White's
 * castling is decided by the arrangement under test rather than by an incidental attack.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MoveFlag, type Move, type PositionState } from '../src/types';
import { NO_CASTLING_ROOK } from '../src/castling';
import { applyMove, generateLegalMoves } from '../src/movegen';
import { IllegalMoveError, Position } from '../src/position';

const isCastle = (m: Move): boolean =>
  (m.flags & (MoveFlag.KingCastle | MoveFlag.QueenCastle)) !== 0;

const castles = (pos: Position): readonly Move[] => pos.legalMoves().filter(isCastle);

/** The back rank of the side that just moved, as it appears in the resulting FEN. */
const whiteBackRank = (pos: Position): string => pos.fen().split(' ')[0].split('/')[7];

interface CastleCase {
  readonly name: string;
  readonly fen: string;
  /** SAN of each castling move expected, in generation order. */
  readonly expected: readonly string[];
  /** White's back rank after playing the first expected castle. */
  readonly after?: string;
  /** UCI spelling of the first expected castle. */
  readonly uci?: string;
}

const CASES: readonly CastleCase[] = [
  {
    name: 'the traditional array still castles exactly as it always did',
    fen: '8/8/8/k7/8/8/8/R3K2R w KQ - 0 1',
    expected: ['O-O', 'O-O-O'],
    after: 'R4RK1',
    uci: 'e1h1',
  },
  {
    name: 'a king that never stood on the e-file',
    fen: '8/8/8/k7/8/8/8/RK5R w KQ - 0 1',
    expected: ['O-O', 'O-O-O'],
    after: 'R4RK1',
    uci: 'b1h1',
  },
  {
    name: 'a king that already stands on its own destination',
    // King g1 castling kingside finishes on g1: it does not move at all, only the rook does.
    fen: '8/8/8/k7/8/8/8/R5KR w KQ - 0 1',
    expected: ['O-O', 'O-O-O'],
    after: 'R4RK1',
    uci: 'g1h1',
  },
  {
    name: 'a rook that already stands on its own destination',
    // The f1 rook is the kingside rook and finishes on f1; only the king travels.
    fen: '8/8/8/k7/8/8/8/R3KR2 w KQ - 0 1',
    expected: ['O-O', 'O-O-O'],
    after: 'R4RK1',
    uci: 'e1f1',
  },
  {
    name: 'a king and rook that cross over each other',
    // King b1 -> g1 travels rightwards past its rook; rook c1 -> f1 travels rightwards past the
    // king. Neither can be applied before the other without a square being briefly wrong.
    fen: '8/8/8/k7/8/8/8/RKR5 w K - 0 1',
    expected: ['O-O'],
    after: 'R4RK1',
    uci: 'b1c1',
  },
  {
    name: 'a king directly adjacent to its rook',
    fen: '8/8/8/k7/8/8/8/R4KR1 w KQ - 0 1',
    expected: ['O-O', 'O-O-O'],
    after: 'R4RK1',
    uci: 'f1g1',
  },
  {
    name: 'a queenside castle from an inner rook',
    fen: '8/8/8/k7/8/8/8/1R2K2R w KQ - 0 1',
    expected: ['O-O', 'O-O-O'],
  },
];

for (const c of CASES) {
  test(`castling: ${c.name}`, () => {
    const pos = Position.fromFen(c.fen, 'chess960');
    const found = castles(pos);
    assert.deepEqual(
      found.map((m) => pos.toSan(m).replace(/[+#]$/, '')),
      c.expected,
      c.fen,
    );
    if (c.uci !== undefined) {
      assert.equal(pos.toUci(found[0]), c.uci, 'UCI spelling');
    }
    if (c.after !== undefined) {
      assert.equal(whiteBackRank(pos.play(found[0])), c.after, 'resulting back rank');
    }
  });
}

test('a castled king and rook always land on the same squares, whatever the arrangement', () => {
  // This is the invariant the whole feature turns on, so it is asserted across every arrangement
  // rather than in the handful of shapes above. Each case clears the back rank down to one king and
  // one rook, which is the only way to reach every relative placement.
  let castled = 0;
  for (let kingFile = 0; kingFile < 8; kingFile++) {
    for (let rookFile = 0; rookFile < 8; rookFile++) {
      if (rookFile === kingFile) continue;
      const rank: string[] = Array.from({ length: 8 }, () => '1');
      rank[kingFile] = 'K';
      rank[rookFile] = 'R';
      const side = rookFile > kingFile ? 'K' : 'Q';
      const fen = `8/8/8/k7/8/8/8/${rank.join('')} w ${side} - 0 1`;
      const pos = Position.fromFen(fen, 'chess960');
      const found = castles(pos);
      if (found.length === 0) continue; // blocked or attacked; covered elsewhere
      assert.equal(found.length, 1);
      castled++;
      const after = pos.play(found[0]);
      assert.equal(
        whiteBackRank(after),
        side === 'K' ? '5RK1' : '2KR4',
        `king ${kingFile} rook ${rookFile} landed wrong`,
      );
    }
  }
  // Without this the `continue` above would make the whole sweep vacuous: a generator that produced
  // no castling move for any arrangement would skip every case and pass. Raised in the CodeRabbit
  // review of PR #10.
  assert.ok(castled >= 50, `only ${castled} of the 56 arrangements produced a castle`);
});

test('the king may not castle out of, through, or into an attacked square', () => {
  const cases: readonly [string, string, number][] = [
    ['out of check', '1r6/8/8/k7/8/8/8/RK5R w K - 0 1', 0],
    ['through an attacked square', '3r4/8/8/k7/8/8/8/RK5R w K - 0 1', 0],
    ['into an attacked square', '6r1/8/8/k7/8/8/8/RK5R w K - 0 1', 0],
    ['with the path unobserved', '8/8/8/k7/8/8/8/RK5R w K - 0 1', 1],
  ];
  for (const [name, fen, expected] of cases) {
    assert.equal(castles(Position.fromFen(fen, 'chess960')).length, expected, name);
  }
});

test('the rook may cross an attacked square, because only the king transit is constrained', () => {
  // Black's rook on f8 attacks f1. The king starts on g1 and finishes on g1, so it never touches
  // f1; the rook travels h1 -> f1 straight across it. Refusing this would be the classic Chess960
  // castling bug — confusing rook exposure with king transit.
  const pos = Position.fromFen('5r2/8/8/k7/8/8/8/R5KR w K - 0 1', 'chess960');
  const found = castles(pos);
  assert.equal(found.length, 1, 'the rook crossing an attacked square is legal');
  assert.equal(whiteBackRank(pos.play(found[0])), 'R4RK1');
});

test('a piece standing anywhere in either span blocks castling', () => {
  // The blocker sits on d1: outside the king's b1->c1 walk but inside the rook's a1->d1 walk. A
  // check that only looked at the king's path would let this through.
  const blocked = Position.fromFen('8/8/8/k7/8/8/8/RK1B4 w Q - 0 1', 'chess960');
  assert.equal(castles(blocked).length, 0, 'd1 blocks the rook even though the king never reaches it');

  const clear = Position.fromFen('8/8/8/k7/8/8/8/RK6 w Q - 0 1', 'chess960');
  assert.equal(castles(clear).length, 1, 'the same position without the blocker castles');
});

test('castling rights follow the rook that holds them, not a corner square', () => {
  // Rooks on b1 and g1, king on d1. Neither is on a corner, so a rights table keyed on a1/h1 would
  // never clear either of them.
  const start = Position.fromFen('8/8/8/k7/8/8/8/1R1K2R1 w KQ - 0 1', 'chess960');
  assert.equal(start.fen().split(' ')[2], 'KQ');

  const rookMoved = start.play('g1g2');
  assert.equal(rookMoved.fen().split(' ')[2], 'Q', 'moving the kingside rook clears only that right');

  const otherMoved = start.play('b1b2');
  assert.equal(otherMoved.fen().split(' ')[2], 'K', 'moving the queenside rook clears only that right');
});

test('a king move clears both rights, and castling itself clears both', () => {
  const start = Position.fromFen('8/8/8/k7/8/8/8/1R1K2R1 w KQ - 0 1', 'chess960');
  assert.equal(start.play('d1d2').fen().split(' ')[2], '-', 'a plain king move surrenders both');

  const castled = start.play('d1g1');
  assert.equal(castled.fen().split(' ')[2], '-', 'castling surrenders both');
  assert.equal(whiteBackRank(castled), '1R3RK1');
});

test('capturing a rook on its own square clears the right it carried', () => {
  // The right has to die where it lives. White's queenside right is held by the rook on b1 — not a
  // corner — so a rights table keyed on a1 would leave it standing after the rook is taken.
  const pos = Position.fromFen('1r2k3/8/8/8/8/8/8/1R1K2R1 b KQ - 0 1', 'chess960');
  assert.equal(pos.fen().split(' ')[2], 'KQ');
  const after = pos.play('b8b1');
  assert.equal(after.fen().split(' ')[2], 'K', 'the captured rook takes its right with it');
});

test('a right the board does not support cannot be exercised, however it got there', () => {
  // Every path inside this package keeps rights and board in step: `parseCastlingField` drops a
  // right naming a rook that is not there, and `updateCastlingRights` clears one the moment its rook
  // moves or is captured. So neither guard below is reachable from a FEN — this position parses to
  // no rights at all, which is itself worth pinning.
  assert.equal(castles(Position.fromFen('8/8/8/k7/8/8/8/4K3 w KQ - 0 1', 'chess960')).length, 0);

  // They are reachable from the exported API, though: `PositionState` and `generateLegalMoves` are
  // both public, so a caller can hand the generator a state whose rights disagree with its board.
  // The generator must not follow a right to an empty square, nor castle a king that has wandered
  // off its back rank.
  const bothRights = { w: { k: 7, q: 0 }, b: { k: NO_CASTLING_ROOK, q: NO_CASTLING_ROOK } };

  const noRook: PositionState = {
    ...Position.fromFen('8/8/8/k7/8/8/8/4K3 w - - 0 1', 'chess960').snapshot(),
    castling: bothRights,
  };
  assert.equal(
    generateLegalMoves(noRook).filter(isCastle).length,
    0,
    'the rights name h1 and a1, but no rook stands on either',
  );

  const kingOffBackRank: PositionState = {
    ...Position.fromFen('8/8/8/k7/8/8/4K3/R6R w - - 0 1', 'chess960').snapshot(),
    castling: bothRights,
  };
  assert.equal(
    generateLegalMoves(kingOffBackRank).filter(isCastle).length,
    0,
    'both rooks are home, but the king is on e2',
  );
});

test('SAN spells castling O-O and O-O-O however far the king actually travels', () => {
  const cases: readonly [string, string][] = [
    ['8/8/8/k7/8/8/8/R5KR w K - 0 1', 'O-O'], // king does not move at all
    ['8/8/8/k7/8/8/8/RK5R w K - 0 1', 'O-O'], // king crosses five files
    ['8/8/8/k7/8/8/8/R6K w Q - 0 1', 'O-O-O'], // king crosses six files the other way
    ['8/8/8/k7/8/8/8/3RK3 w Q - 0 1', 'O-O-O'], // rook already home; only the king travels
  ];
  for (const [fen, san] of cases) {
    const pos = Position.fromFen(fen, 'chess960');
    const found = castles(pos);
    assert.equal(found.length, 1, fen);
    assert.equal(pos.toSan(found[0]).replace(/[+#]$/, ''), san, fen);
  }
});

test('a Chess960 castle round-trips through its UCI spelling', () => {
  const pos = Position.fromFen('8/8/8/k7/8/8/8/RK5R w KQ - 0 1', 'chess960');
  for (const move of castles(pos)) {
    const uci = pos.toUci(move);
    assert.equal(pos.play(uci).fen(), pos.play(move).fen(), uci);
  }
});

test('the two UCI spellings cannot collide, because a king never steps onto its own rook', () => {
  // King f1, rooks a1 and h1. `f1g1` is an ordinary one-square step onto an empty square; `f1h1` is
  // the castle, named by the rook. They stay distinct for a structural reason rather than by luck:
  // king-takes-rook always names a square holding the mover's own rook, and no ordinary move can
  // land there. So neither spelling can ever be read as the other.
  const pos = Position.fromFen('8/8/8/k7/8/8/8/R4K1R w KQ - 0 1', 'chess960');

  assert.equal(whiteBackRank(pos.play('f1g1')), 'R5KR', 'f1g1 is the step, leaving both rooks put');
  assert.equal(whiteBackRank(pos.play('f1h1')), 'R4RK1', 'f1h1 is the castle');

  // And when the rook *is* adjacent, the step is simply illegal, so the castle owns the spelling.
  const adjacent = Position.fromFen('8/8/8/k7/8/8/8/R4KR1 w KQ - 0 1', 'chess960');
  assert.equal(whiteBackRank(adjacent.play('f1g1')), 'R4RK1', 'f1g1 can only be the castle here');
});

test('a hand-built castling move still plays, in standard and in Chess960', () => {
  // `Position.play` takes a `Move`, and a caller may build one rather than pass back something from
  // `legalMoves()`. Requiring `castleRook` unconditionally silently narrowed that: the ordinary way
  // to express standard castling began throwing. Raised in the CodeRabbit review of PR #10.
  const standard = Position.fromFen('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1', 'standard');
  const kingside: Move = { from: 4, to: 6, piece: 'K', flags: MoveFlag.KingCastle };
  const queenside: Move = { from: 4, to: 2, piece: 'K', flags: MoveFlag.QueenCastle };
  assert.equal(whiteBackRank(standard.play(kingside)), 'R4RK1');
  assert.equal(whiteBackRank(standard.play(queenside)), '2KR3R');

  // The same in Chess960, where the rook is not on h1 — the flag alone is enough to say which
  // castle is meant, and the generated move supplies the rook.
  const c960 = Position.fromFen('8/8/8/k7/8/8/8/R3KR2 w KQ - 0 1', 'chess960');
  assert.equal(whiteBackRank(c960.play({ from: 4, to: 6, piece: 'K', flags: MoveFlag.KingCastle })), 'R4RK1');

  // And where the caller *does* name the rook, that still wins. This is the ambiguous shape: the
  // king on b1 can both castle to c1 and simply step to c1, so `from`/`to` alone cannot choose, and
  // comparing only those resolved the castle to the step and left the rook on a1.
  const ambiguous = Position.fromFen('8/8/8/k7/8/8/8/RK5R w Q - 0 1', 'chess960');
  const castle = castles(ambiguous)[0];
  assert.equal(castle.to, 2, 'the castle lands the king on c1');
  assert.ok(
    ambiguous.legalMoves().some((m) => m.from === castle.from && m.to === castle.to && !isCastle(m)),
    'and an ordinary king step to c1 exists alongside it',
  );
  assert.equal(whiteBackRank(ambiguous.play(castle)), '2KR3R', 'the rook comes with it');

  // The flag alone must also be enough *here*, where it is the only thing separating the two. The
  // earlier standard cases cannot show this: e1->g1 is two squares, so no ordinary king move
  // competes with the castle and any tie-break at all would appear to work.
  assert.equal(
    whiteBackRank(ambiguous.play({ from: 1, to: 2, piece: 'K', flags: MoveFlag.QueenCastle })),
    '2KR3R',
    'a flag-only castle must not resolve to the ordinary king step',
  );
  assert.equal(
    whiteBackRank(ambiguous.play({ from: 1, to: 2, piece: 'K', flags: MoveFlag.Normal })),
    'R1K4R',
    'and asking for the plain move must still give the plain move',
  );
});

test('a castling move without its rook is refused rather than applied', () => {
  // `applyMove` is part of the public surface, so a caller can build a move by hand. A castle
  // missing `castleRook` has no origin to vacate, and applying it anyway would duplicate the rook —
  // wrong in a way nothing downstream could detect.
  const pos = Position.fromFen('8/8/8/k7/8/8/8/R3K2R w KQ - 0 1', 'chess960');
  const real = castles(pos)[0];
  const { castleRook: _dropped, ...withoutRook } = real;
  assert.throws(
    () => applyMove(pos.snapshot(), withoutRook as Move),
    /castleRook/,
  );
  // The genuine move, carrying its rook, still applies.
  assert.equal(whiteBackRank(pos.play(real)), 'R4RK1');
});

test('the arbitrary-origin rule is Chess960 only: other variants keep the traditional squares', () => {
  // Ordinary chess does not merely happen to castle from e1 with a rook on a or h — it permits
  // nothing else. Applying the general form to every rule set let a standard position with a king on
  // d1 and a rook on h1 generate `d1g1`: a legal Chess960 castle and an illegal standard one.
  // Raised in the Qodo review of PR #10.
  const offFileKing = '4k3/8/8/8/8/8/8/3K3R w K - 0 1';
  const innerRook = '4k3/8/8/8/8/8/8/4K1R1 w K - 0 1';

  for (const variant of ['standard', 'kingofthehill', 'atomic', 'crazyhouse', 'threecheck'] as const) {
    assert.equal(
      castles(Position.fromFen(offFileKing, variant)).length,
      0,
      `${variant}: a king off the e-file must not castle`,
    );
    assert.equal(
      castles(Position.fromFen(innerRook, variant)).length,
      0,
      `${variant}: a rook off the a/h-files must not castle`,
    );
  }

  // The very same positions are legal Chess960 castles, which is what makes the gate load-bearing
  // rather than a formality.
  assert.equal(castles(Position.fromFen(offFileKing, 'chess960')).length, 1);
  assert.equal(castles(Position.fromFen(innerRook, 'chess960')).length, 1);
});

test('king-takes-rook is a Chess960 input spelling and is refused elsewhere', () => {
  // `toUci` already gated this notation on the variant; resolution has to draw the same boundary, or
  // `play` — the one entry point whose job is refusing illegal moves — accepts a string no standard
  // engine or GUI ever produces. Raised in the Qodo review of PR #10.
  const fen = '4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1';

  const standard = Position.fromFen(fen, 'standard');
  assert.equal(whiteBackRank(standard.play('e1g1')), 'R4RK1', 'standard castles as e1g1');
  assert.throws(() => standard.play('e1h1'), IllegalMoveError, 'standard must refuse e1h1');

  const chess960 = Position.fromFen(fen, 'chess960');
  assert.equal(whiteBackRank(chess960.play('e1h1')), 'R4RK1', 'chess960 castles as e1h1');
});

test('standard chess keeps its own UCI spelling, unchanged', () => {
  // The king-takes-rook convention is a Chess960 wire detail and must not leak into ordinary chess,
  // where every GUI and engine expects e1g1.
  const pos = Position.fromFen('8/8/8/k7/8/8/8/R3K2R w KQ - 0 1', 'standard');
  const found = castles(pos);
  assert.deepEqual(found.map((m) => pos.toUci(m)), ['e1g1', 'e1c1']);
});
