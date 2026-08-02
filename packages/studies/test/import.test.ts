import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Position } from '@chess-platform/core';
import {
  START_FEN,
  StudyRuleError,
  chapterNameFor,
  importGame,
  parsePgn,
  type ImportedNode,
  type PositionReader,
} from '../src';

/**
 * The real engine, wired the way the API will wire it. Using a fake here would test the fake: the
 * whole point of `PositionReader` is that SAN resolution goes through the engine's own SAN writer,
 * so a stub that invents SAN would prove nothing about the thing under test.
 */
const engine: PositionReader = {
  legalSans(fen) {
    const pos = Position.fromFen(fen);
    return pos.legalMoves().map((m) => pos.toSan(m));
  },
  play(fen, san) {
    const pos = Position.fromFen(fen);
    for (const move of pos.legalMoves()) {
      if (pos.toSan(move) === san) {
        return pos.play(move).fen();
      }
    }
    throw new Error(`illegal move ${san}`);
  },
};

function firstGame(pgn: string) {
  const [game] = parsePgn(pgn);
  assert.ok(game);
  return game;
}

/** Walks the tree collecting SANs depth-first, so structure is visible in one assertion. */
function shape(nodes: readonly ImportedNode[]): unknown {
  return nodes.map((n) => (n.children.length === 0 ? n.san : { [n.san]: shape(n.children) }));
}

describe('PGN import', () => {
  it('builds a mainline where each move is a child of the one before', () => {
    const chapter = importGame(engine, firstGame('1. e4 e5 2. Nf3 *'), 'Test');
    assert.equal(chapter.startingFen, START_FEN);
    assert.deepEqual(shape(chapter.nodes), [{ e4: [{ e5: ['Nf3'] }] }]);
  });

  it('attaches a variation as a SIBLING of the move it replaces, not as its child', () => {
    // `(1... c5)` is an alternative to e5, so both are replies to e4. Hanging it off e5 instead
    // produces a tree that loads and renders and is quietly wrong — it would claim c5 answers e5.
    const chapter = importGame(engine, firstGame('1. e4 e5 (1... c5) 2. Nf3 *'), 'Test');

    const e4 = chapter.nodes[0];
    assert.equal(e4?.san, 'e4');
    assert.deepEqual(
      e4?.children.map((c) => c.san),
      ['e5', 'c5'],
      'e5 and c5 are both replies to e4'
    );
    assert.deepEqual(e4?.children[0]?.children.map((c) => c.san), ['Nf3']);
    assert.deepEqual(e4?.children[1]?.children, [], 'the variation ended after c5');
  });

  it('resolves a variation from the position before its parent move', () => {
    // If a variation resolved from the position AFTER its parent, c5 would be illegal here (a black
    // move in a white-to-move position) and the import would fail. That it succeeds is the check.
    const chapter = importGame(engine, firstGame('1. e4 e5 (1... c5 2. Nf3 d6) 2. Nf3 *'), 'T');
    const c5 = chapter.nodes[0]?.children[1];
    assert.equal(c5?.san, 'c5');
    assert.deepEqual(shape([c5!]), [{ c5: [{ Nf3: ['d6'] }] }]);
  });

  it('keeps every alternative when a variation itself starts with a variation', () => {
    // `(1... c5 (1... e6))` is two alternatives to e5, not one. Taking only the first node of each
    // parsed variation line looks right and silently drops e6 — a move the file contains and the
    // imported study would not. All three are replies to e4.
    const chapter = importGame(engine, firstGame('1. e4 e5 (1... c5 (1... e6)) 2. Nf3 *'), 'Test');
    assert.deepEqual(
      chapter.nodes[0]?.children.map((c) => c.san),
      ['e5', 'c5', 'e6']
    );
  });

  it('records the position after each move so a later append need not replay the line', () => {
    const chapter = importGame(engine, firstGame('1. e4 *'), 'Test');
    assert.match(chapter.nodes[0]!.fenAfter, /^rnbqkbnr\/pppppppp\/8\/8\/4P3\/8\/PPPP1PPP\/RNBQKBNR b/);
  });

  it('keeps comments and NAGs on the move they annotate', () => {
    const chapter = importGame(engine, firstGame('1. e4 {best by test} $1 *'), 'Test');
    assert.equal(chapter.nodes[0]?.comment, 'best by test');
    assert.deepEqual(chapter.nodes[0]?.nags, [1]);
  });

  it('starts from the FEN tag when the game carries one', () => {
    const fen = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
    const chapter = importGame(engine, firstGame(`[FEN "${fen}"]\n\n1. e4 *\n`), 'Test');
    assert.equal(chapter.startingFen, fen);
    assert.deepEqual(shape(chapter.nodes), ['e4']);
  });

  it('rejects an unplayable game outright rather than importing it half-way', () => {
    // A half-imported chapter looks complete and silently stops at the first bad move. A reader
    // cannot tell that from a game that really ended there, which is why this is all-or-nothing.
    assert.throws(
      () => importGame(engine, firstGame('1. e4 e5 2. Nf6 *'), 'Test'),
      (err: unknown) => {
        assert.ok(err instanceof StudyRuleError);
        assert.equal(err.code, 'invalid_move');
        assert.match(err.message, /Nf6/, 'the error must name the move that failed');
        return true;
      }
    );
  });

  it('accepts annotation suffixes in any combination', () => {
    // `Qh5+!` is the case that broke: stripping `[+#]` and then `[!?]` in two passes leaves `Qh5+`,
    // because the first pass sees a string ending in `!` and matches nothing. The engine writes
    // `Qh5+`, which bares to `Qh5`, and the two never meet.
    const annotated = '1. e4! e5?! 2. Bc4!? Nc6 3. Qh5+!! Nf6?? 4. Qxf7#! *';
    const chapter = importGame(engine, firstGame(annotated), 'Test');
    assert.deepEqual(shape(chapter.nodes), [
      { e4: [{ e5: [{ Bc4: [{ Nc6: [{ Qh5: [{ Nf6: ['Qxf7#'] }] }] }] }] }] },
    ]);
  });

  it('accepts SAN that omits a check suffix the engine would write', () => {
    // Real exports disagree with each other about `+` and `#`. They do not identify the move, so a
    // file that omits one is describing the same game and must import.
    const chapter = importGame(engine, firstGame('1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7 *'), 'Test');
    assert.deepEqual(shape(chapter.nodes), [{ e4: [{ e5: [{ Bc4: [{ Nc6: [{ Qh5: [{ Nf6: ['Qxf7#'] }] }] }] }] }] }]);
  });

  it('names a chapter from the players, then the event, then its index', () => {
    assert.equal(chapterNameFor(firstGame('[White "A"]\n[Black "B"]\n\n*\n'), 0), 'A vs B');
    assert.equal(chapterNameFor(firstGame('[Event "Open"]\n\n*\n'), 0), 'Open');
    assert.equal(chapterNameFor(firstGame('*\n'), 4), 'Chapter 5');
  });
});
