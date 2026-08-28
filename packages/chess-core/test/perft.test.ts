/**
 * Perft verification: the definitive correctness test for a move generator.
 * Node counts below are the published reference values used across the chess
 * programming community (e.g. the Chess Programming Wiki).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Position } from '../src/position';
import { MoveFlag, type Variant } from '../src/types';

interface PerftCase {
  name: string;
  fen: string;
  expected: number[]; // index = depth-1
  variant?: Variant;
}

function assertPerftCase(c: PerftCase): void {
  const variant = c.variant ?? 'standard';
  const pos = Position.fromFen(c.fen, variant);
  c.expected.forEach((exp, i) => {
    const depth = i + 1;
    const got = pos.perft(depth);
    assert.equal(got, exp, `${c.name} depth ${depth}: expected ${exp}, got ${got}`);
  });
}

// Reference: https://www.chessprogramming.org/Perft_Results
const CASES: PerftCase[] = [
  {
    name: 'startpos',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    expected: [20, 400, 8902, 197281],
  },
  {
    name: 'kiwipete',
    fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    expected: [48, 2039, 97862],
  },
  {
    name: 'position-3 (en passant / promotions)',
    fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    expected: [14, 191, 2812, 43238],
  },
  {
    name: 'position-4 (promotions & pins)',
    fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
    expected: [6, 264, 9467],
  },
  {
    name: 'position-5',
    fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    expected: [44, 1486, 62379],
  },
];

for (const c of CASES) {
  test(`perft: ${c.name}`, () => {
    assertPerftCase(c);
  });
}

/**
 * Variant coverage.
 *
 * Every case above runs `standard`. `types.ts` declares eight variants and `movegen.ts` branches on
 * the variant in six places, so seven rule sets had no perft verification at all.
 *
 * None of the numbers below were produced by running this move generator. Recording what the
 * implementation currently prints and calling it `expected` is a golden master: it locks in today's
 * bugs and passes forever regardless of correctness. Every value here is either a published
 * reference already used above, or a relationship that no fixed output could satisfy.
 */

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';

/**
 * `kingofthehill` and `threecheck` change only the terminal condition (`position.ts`), not move
 * generation; `chess960` differs only in castling, and the standard array is Chess960 start position
 * 518, where castling is the standard arrangement. So at depths where the variant's own terminal
 * condition cannot fire, their perft must equal the published standard counts exactly.
 *
 * That bound is why the depths stop where they do: a king cannot reach a central square, and three
 * checks cannot be delivered, within five plies of the opening position.
 */
const IDENTICAL_TO_STANDARD: Variant[] = ['chess960', 'kingofthehill', 'threecheck'];

for (const variant of IDENTICAL_TO_STANDARD) {
  test(`perft: ${variant} matches standard on startpos (movegen is unchanged)`, () => {
    [20, 400, 8902, 197281].forEach((exp, i) => {
      const got = Position.fromFen(STARTPOS, variant).perft(i + 1);
      assert.equal(got, exp, `${variant} startpos depth ${i + 1}: expected ${exp}, got ${got}`);
    });
  });

  test(`perft: ${variant} matches standard on kiwipete`, () => {
    [48, 2039, 97862].forEach((exp, i) => {
      const got = Position.fromFen(KIWIPETE, variant).perft(i + 1);
      assert.equal(got, exp, `${variant} kiwipete depth ${i + 1}: expected ${exp}, got ${got}`);
    });
  });
}

/**
 * Equality alone would be satisfied by an implementation that had quietly forgotten a variant
 * entirely, so the variants that must diverge are pinned too — as relationships rather than counts,
 * because a relationship cannot be met by a generator returning a fixed number.
 */
test('perft: crazyhouse matches standard until a drop is legal, then exceeds it', () => {
  // Ply 1 white, 2 black, 3 white, 4 black. White's earliest capture is ply 3, so black — to move on
  // ply 4 — still holds an empty pocket and has no drop to make. Through depth 4 the two are equal.
  [20, 400, 8902, 197281].forEach((exp, i) => {
    const got = Position.fromFen(STARTPOS, 'crazyhouse').perft(i + 1);
    assert.equal(got, exp, `crazyhouse depth ${i + 1}: expected ${exp}, got ${got}`);
  });

  // Give white a pawn in hand rather than searching five plies to earn one. The count that follows
  // is arithmetic, not a reading taken off this engine: the opening array leaves ranks 3-6 empty,
  // that is 4 x 8 = 32 squares, and a pawn may be dropped on any of them — rank 1 and rank 8 are the
  // forbidden ranks and neither is in range. So 20 ordinary moves + 32 drops = 52.
  //
  // Reaching the same fact by comparing perft(5) totals also works and is what this test did first,
  // but it cost 12 seconds of the package's 15 and proved something weaker: that one number exceeded
  // another, without saying by how much or why.
  const withPawnInHand = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[P] w KQkq - 0 1';
  assert.equal(
    Position.fromFen(withPawnInHand, 'crazyhouse').perft(1),
    20 + 32,
    'a pawn in hand must add exactly one drop per empty square on ranks 3-6',
  );

  // And the same position with an empty pocket must lose precisely those 32 nodes, so the delta is
  // attributable to the drops rather than to anything else the variant does.
  assert.equal(Position.fromFen(STARTPOS, 'crazyhouse').perft(1), 20);
});

test('perft: atomic matches standard until the first capture, then diverges', () => {
  // No capture is available inside three plies of the opening position, so nothing has exploded yet.
  [20, 400, 8902].forEach((exp, i) => {
    const got = Position.fromFen(STARTPOS, 'atomic').perft(i + 1);
    assert.equal(got, exp, `atomic depth ${i + 1}: expected ${exp}, got ${got}`);
  });

  // Depth 4 reaches white's first captures, which remove both pieces and change what follows.
  const atomicDepth4 = Position.fromFen(STARTPOS, 'atomic').perft(4);
  assert.notEqual(
    atomicDepth4,
    197281,
    'atomic depth 4 must differ from standard: captures explode and change the resulting positions',
  );
});

/**
 * Independently sourced perft reference vectors for `horde` and `racingkings`.
 * Sourced from lichess-org/scalachess:
 * - https://raw.githubusercontent.com/lichess-org/scalachess/master/test-kit/src/test/resources/horde.perft
 * - https://raw.githubusercontent.com/lichess-org/scalachess/master/test-kit/src/test/resources/racingkings.perft
 */

const VARIANT_CASES: PerftCase[] = [
  // Horde
  {
    name: 'horde-start',
    variant: 'horde',
    fen: 'rnbqkbnr/pppppppp/8/1PP2PP1/PPPPPPPP/PPPPPPPP/PPPPPPPP/PPPPPPPP w kq - 0 1',
    expected: [8, 128, 1274, 23310],
  },
  {
    name: 'horde-open-flank',
    variant: 'horde',
    fen: '4k3/pp4q1/3P2p1/8/P3PP2/PPP2r2/PPP5/PPPP4 b - - 0 1',
    expected: [30, 241, 6633, 56539],
  },
  {
    name: 'horde-en-passant',
    variant: 'horde',
    fen: 'k7/5p2/4p2P/3p2P1/2p2P2/1p2P2P/p2P2P1/2P2P2 w - - 0 1',
    expected: [13, 172, 2205, 33781],
  },
  // Racing Kings
  {
    name: 'racingkings-start',
    variant: 'racingkings',
    fen: '8/8/8/8/8/8/krbnNBRK/qrbnNBRQ w - - 0 1',
    expected: [21, 421, 11264, 296242, 9472927],
  },
  {
    name: 'occupied-goal',
    variant: 'racingkings',
    fen: '4brn1/2K2k2/8/8/8/8/8/8 w - - 0 1',
    expected: [6, 33, 178, 3151, 12981, 265932],
  },
  {
    name: 'near-discovered-check',
    variant: 'racingkings',
    fen: '8/8/1rk4K/8/8/8/2bnNBR1/qrbnNBRQ b - - 0 1',
    expected: [36, 697, 26592, 661533],
  },
];

for (const c of VARIANT_CASES) {
  test(`perft (${c.variant}): ${c.name}`, () => {
    assertPerftCase(c);
  });
}

test('perft divide: a variant-terminal position has no root branches', () => {
  const terminal = Position.fromFen('2K5/8/8/8/8/8/8/4k3 b - - 0 1', 'racingkings');
  assert.equal(terminal.perft(1), 0);
  assert.deepEqual(terminal.perftDivide(1), {});
});

/**
 * Horde: only White is a horde. Black is an ordinary army and castles.
 *
 * `generateCastles` used to return early for the whole variant, which suppressed Black's castling
 * too — while `HORDE_FEN` granted Black `kq`. The engine handed out rights it then refused to
 * honour. Raised in the CodeRabbit review of PR #10; see ADR-0136.
 *
 * There is no published perft vector that can settle this: all three Horde vectors above start with
 * Black's back rank full, so no castle is reachable at any depth they cover. The evidence is
 * therefore the rule itself and a relationship, not a node count:
 *
 * - Lichess states the rule as "a move is legal if and only if it is legal in standard chess for a
 *   similar position", with an exception only for The Pawns — castling is not among the exceptions;
 * - `HORDE_FEN` here, and the identical starting FEN in python-chess's `HordeBoard`, both grant `kq`
 *   and apply no castling override for Black.
 *
 * The relationship below is what a fixed number cannot satisfy: Horde changes White's pawns and the
 * win conditions, and nothing about how Black moves. So for any board with Black to move, Black's
 * legal moves under `horde` must be exactly those under `standard`.
 */
const HORDE_BLACK_TO_MOVE: readonly string[] = [
  'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/PPPPPPPP b kq - 0 1',
  'r3k2r/pp1ppppp/8/8/8/8/PPPPPPPP/PPPPPPPP b kq - 0 1',
  'rn2k1nr/pppppppp/8/8/8/8/PPPPPPPP/PPPPPPPP b kq - 0 1',
  'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/PPPPPPPP b - - 0 1',
];

test('horde: Black moves exactly as in standard chess, castling included', () => {
  for (const fen of HORDE_BLACK_TO_MOVE) {
    const horde = Position.fromFen(fen, 'horde');
    const standard = Position.fromFen(fen, 'standard');
    assert.deepEqual(
      horde.legalMoves().map((m) => horde.toSan(m)).sort(),
      standard.legalMoves().map((m) => standard.toSan(m)).sort(),
      `Black's moves diverge from standard in: ${fen}`,
    );
  }
});

test('horde: Black castles to the ordinary squares, and loses the right the ordinary way', () => {
  // Asserted separately from the relationship above, which would be satisfied if *both* rule sets
  // lost castling together.
  const pos = Position.fromFen(HORDE_BLACK_TO_MOVE[0], 'horde');
  const castles = pos.legalMoves().filter((m) => (m.flags & (MoveFlag.KingCastle | MoveFlag.QueenCastle)) !== 0);
  assert.deepEqual(castles.map((m) => pos.toSan(m).replace(/[+#]$/, '')), ['O-O', 'O-O-O']);

  assert.equal(pos.play(castles[0]).fen().split(' ')[0].split('/')[0], 'r4rk1', 'kingside');
  assert.equal(pos.play(castles[1]).fen().split(' ')[0].split('/')[0], '2kr3r', 'queenside');

  // A rook move still surrenders exactly one right, as anywhere else.
  assert.equal(pos.play('a8b8').fen().split(' ')[2], 'k', 'the a8 rook takes its right with it');
});

test('racing kings forbids castling, and that refusal is the variant, not the position', () => {
  // The counterpart to the Horde change: `generateCastles` still returns early for Racing Kings, and
  // that guard had no test — mutation testing showed it could be deleted without a failure. The
  // published Racing Kings vectors cannot cover it, since all of them carry no castling rights at
  // all, and the start position keeps both kings off their back ranks.
  //
  // Asserted as a relationship so it cannot be satisfied by a generator that has simply stopped
  // producing castles: the identical board must castle under standard rules and must not under
  // Racing Kings.
  const fen = '4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1';
  const isCastle = (m: { flags: number }) =>
    (m.flags & (MoveFlag.KingCastle | MoveFlag.QueenCastle)) !== 0;

  assert.equal(
    Position.fromFen(fen, 'standard').legalMoves().filter(isCastle).length,
    2,
    'the position itself permits castling',
  );
  assert.equal(
    Position.fromFen(fen, 'racingkings').legalMoves().filter(isCastle).length,
    0,
    'and Racing Kings is what refuses it',
  );
});

test('horde: the pawn army has no king and therefore no castling', () => {
  // The early return that used to cover White was not merely wrong for Black, it was unnecessary for
  // White: `generateCastles` is reached only from the king branch of move generation.
  const start = Position.initial('horde');
  assert.equal(start.turn, 'w');
  assert.equal(
    start.legalMoves().filter((m) => (m.flags & (MoveFlag.KingCastle | MoveFlag.QueenCastle)) !== 0).length,
    0,
  );
  assert.equal(start.fen().split(' ')[2], 'kq', 'and Black keeps the rights the start position grants');
});
