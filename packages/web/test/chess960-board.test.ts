import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardInteraction } from '../src/core/interaction.js';
import { AuthoritativeMoveOracle } from '../src/net/authoritative-oracle.js';
import { applyMove } from '../src/core/mover.js';
import type { LegalMoves } from '../src/net/ws-protocol.js';
import { OFFERED_VARIANTS } from '../src/api/models.js';
import { VARIANT_LABELS } from '../src/app/variant-labels.js';

/**
 * Chess960 move input in the browser.
 *
 * The claim under test is that **move input** needs no Chess960 knowledge in the client — which is not
 * the same as the client needing none at all, since `applyMove` projects broadcasts onto its own board
 * and does need to understand king-takes-rook (see the projection tests at the end of this file).
 *
 * For input: `BoardInteraction`
 * contains no chess rules: it asks an oracle for a square's legal destinations and returns whatever
 * the user picked. The oracle is fed the server's authoritative `legalMoves` map, which the gateway
 * builds with `position.toUci(move)` — and in Chess960 that spells castling king-takes-rook
 * (ADR-0136 §4). So the correct move falls out of the existing machinery.
 *
 * That is a claim worth testing rather than asserting, because the failure mode is silent: a client
 * that submitted the king's *destination* would send a move the server refuses, and nothing in the
 * types would have said so.
 */

/** Position 700 after the queenside path is cleared: king d1, rooks a1/h1, bishop gone from b1. */
const SP700_CLEARED_FEN = 'rbqknnbr/1ppppp2/p5pp/8/2P5/2Q5/PPBPPPPP/R2KNNBR w KQkq - 0 4';

/**
 * What the server sends for that position: the king may castle to either rook square, and may also
 * step to c1 as an ordinary move.
 *
 * `d1a1` and `d1c1` are the pair that matters. Castling queenside puts the king on c1, which is also
 * where a plain one-square step lands, so the two moves are distinguishable *only* by the rook-square
 * spelling. A UI that resolved castling by the king's destination could not tell them apart.
 */
const SP700_LEGAL: LegalMoves = {
  d1: ['c1', 'a1', 'h1'],
  c4: ['c5'],
  b2: ['b3', 'b4'],
};

/** White's back rank as eight characters, file a first, `.` for empty. FEN run-length-encodes. */
function whiteBackRank(fen: string): string {
  const rank = fen.split(' ')[0]!.split('/')[7]!;
  return [...rank].map((c) => (/[0-9]/.test(c) ? '.'.repeat(Number(c)) : c)).join('');
}

function interactionOn(fen: string, legal: LegalMoves): BoardInteraction {
  const oracle = new AuthoritativeMoveOracle({ getLegalMoves: () => legal });
  const interaction = new BoardInteraction({ oracle, playerColor: 'white', myTurn: true });
  interaction.setPosition(fen);
  return interaction;
}

test('the board highlights the rook squares as castling destinations', () => {
  const interaction = interactionOn(SP700_CLEARED_FEN, SP700_LEGAL);
  interaction.tap('d1');
  assert.deepEqual(
    [...interaction.highlights().legal].sort(),
    ['a1', 'c1', 'h1'],
    'the rook squares are offered, because that is what the server called legal',
  );
});

test('tapping the rook produces the king-takes-rook move the server expects', () => {
  for (const [rook, side] of [['a1', 'queenside'], ['h1', 'kingside']] as const) {
    const interaction = interactionOn(SP700_CLEARED_FEN, SP700_LEGAL);
    interaction.tap('d1');
    const result = interaction.tap(rook);

    assert.equal(result.kind, 'move', `${side}: tapping the rook resolves to a move`);
    if (result.kind !== 'move') throw new Error('unreachable');
    assert.deepEqual(
      result.move,
      { from: 'd1', to: rook },
      `${side}: submitted as d1${rook}, not as the king's destination`,
    );
  }
});

test('dragging the king onto the rook castles too', () => {
  // Click-to-move and drag/drop are separate entry points into the same resolver, and only one of
  // them being right is a real failure mode.
  const interaction = interactionOn(SP700_CLEARED_FEN, SP700_LEGAL);
  const result = interaction.drop('d1', 'a1');
  assert.equal(result.kind, 'move');
  if (result.kind !== 'move') throw new Error('unreachable');
  assert.deepEqual(result.move, { from: 'd1', to: 'a1' });
});

test('the ordinary king step to c1 stays an ordinary king step', () => {
  // The collision case. `d1c1` and `d1a1` both put the king on c1; a UI that helpfully "corrected"
  // the step into a castle would take away a legal move and play a different one.
  const interaction = interactionOn(SP700_CLEARED_FEN, SP700_LEGAL);
  interaction.tap('d1');
  const result = interaction.tap('c1');

  assert.equal(result.kind, 'move');
  if (result.kind !== 'move') throw new Error('unreachable');
  assert.deepEqual(result.move, { from: 'd1', to: 'c1' }, 'still the plain step');
});

test('tapping own rook is a castle here, but a reselect where the server did not offer it', () => {
  // `BoardInteraction.attempt` reselects when the target holds one of your own pieces — which is
  // exactly what a rook is. The only thing that keeps castling working is that the rook square is a
  // *legal target*, and legality is checked first. Pinning both branches, because a refactor that
  // reordered them would break castling while leaving every ordinary move working.
  const withoutCastles: LegalMoves = { d1: ['c1'], a1: ['b1'] };
  const interaction = interactionOn(SP700_CLEARED_FEN, withoutCastles);
  interaction.tap('d1');
  const result = interaction.tap('a1');

  assert.equal(result.kind, 'select', 'with no castle on offer, the rook is simply selected instead');
});

test('standard castling is unaffected: the king destination is still what gets submitted', () => {
  // The mirror. Standard UCI spells castling `e1g1` and refuses `e1h1` (ADR-0136 §7), and the server
  // says so by putting `g1` in the legal-move map. The client follows the map, so it is right in both
  // variants without knowing which one it is in.
  const standard: LegalMoves = { e1: ['f1', 'g1', 'd1', 'c1'] };
  const interaction = interactionOn(
    'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1',
    standard,
  );
  interaction.tap('e1');
  const result = interaction.tap('g1');

  assert.equal(result.kind, 'move');
  if (result.kind !== 'move') throw new Error('unreachable');
  assert.deepEqual(result.move, { from: 'e1', to: 'g1' }, 'e1g1, never e1h1');
});

test('a non-standard back rank renders from the FEN like any other position', () => {
  // The board parses placement generically, so nothing about the arrangement needs special handling.
  // Worth pinning because "the client cannot render a shuffled back rank" would be an easy thing to
  // assume and an expensive thing to discover.
  const interaction = interactionOn(SP700_CLEARED_FEN, SP700_LEGAL);
  interaction.tap('d1');
  assert.equal(interaction.highlights().selected, 'd1', 'the king on d1 is a selectable own piece');

  const notMine = interactionOn(SP700_CLEARED_FEN, SP700_LEGAL);
  assert.equal(notMine.tap('a8').kind, 'none', 'and a black piece is not');
});

test('chess960 is offered in the lobby and has a label to render', () => {
  assert.ok(OFFERED_VARIANTS.includes('chess960'), 'the variant selector will render it');
  assert.equal(VARIANT_LABELS['chess960'], 'Chess960', 'and it has a human label, not a raw code');
});

// --- Local projection of a live castle broadcast -----------------------------

/**
 * A move broadcast carries `fenHash`, not a FEN, so the client projects the move onto its own board
 * with `applyMove` and only resyncs on the next full snapshot. That projection has to agree with the
 * server, or the board goes visibly wrong — king and rook both — until a snapshot arrives.
 *
 * This is the gap the PR's first round of tests missed: the end-to-end test resynced from the
 * authority after every move, so it exercised the *oracle* and never the projection. Raised in the
 * CodeRabbit review of PR #12, which found `d1a1` projecting to a king on a1 with the rook deleted.
 */
test('a chess960 castle projects to the same board the server has', () => {
  const before = 'rbqknnbr/1ppppp2/p5pp/8/2P5/2Q5/PPBPPPPP/R2KNNBR w KQkq - 0 4';
  const after = applyMove(before, { from: 'd1', to: 'a1' });

  assert.equal(
    whiteBackRank(after),
    '..KRNNBR',
    'king to c1 and rook to d1 — not the king parked on the rook square',
  );
});

test('chess960 castling projects correctly whichever side, and however far the spelling reaches', () => {
  // The distance is the trap. King-takes-rook spans one file when the king already stands on its
  // destination, three here, and can be exactly two — which the old two-file rule would have read as
  // an ordinary kingside castle and resolved through the wrong rook.
  const cases: readonly (readonly [string, string, string, string])[] = [
    // king d1, rooks a1/h1 — queenside spans three files
    ['R2KNNBR', 'd1', 'a1', '..KRNNBR'],
    // the same king castling the other way, on a cleared rank so the case is about the spelling
    // rather than about pieces this projector would happily overwrite (it has no legality, by design)
    ['3K3R', 'd1', 'h1', '.....RK.'],
    // king g1, rook h1 — kingside spans one file and the king ends where it began
    ['6KR', 'g1', 'h1', '.....RK.'],
    // king d1, rook f1 — exactly two files, and it is a *kingside* castle
    ['3K1R2', 'd1', 'f1', '.....RK.'],
  ];

  for (const [back, from, to, expected] of cases) {
    const fen = `8/8/8/8/8/8/8/${back} w - - 0 1`;
    assert.equal(
      whiteBackRank(applyMove(fen, { from, to })),
      expected,
      `${back}: ${from}${to}`,
    );
  }
});

test('standard castling and ordinary king moves project exactly as before', () => {
  const std = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
  assert.equal(whiteBackRank(applyMove(std, { from: 'e1', to: 'g1' })), 'R....RK.');
  assert.equal(whiteBackRank(applyMove(std, { from: 'e1', to: 'c1' })), '..KR...R');

  // A king stepping one square is not a castle, even onto a square a castle could also reach.
  const sp700 = 'rbqknnbr/1ppppp2/p5pp/8/2P5/2Q5/PPBPPPPP/R2KNNBR w KQkq - 0 4';
  assert.equal(
    whiteBackRank(applyMove(sp700, { from: 'd1', to: 'c1' })),
    'R.K.NNBR',
    'the rook stays on a1',
  );
});
