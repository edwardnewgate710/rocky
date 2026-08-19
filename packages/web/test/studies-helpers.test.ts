import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatNag,
  formatNags,
  buildMoveTree,
  formatMovePrefix,
  parseStartingFen,
} from '../src/app/studies-helpers.js';
import type { TreeNodeView } from '../src/api/models.js';

test('formatNag maps 1-6 correctly and returns empty string for out-of-range NAGs', () => {
  assert.equal(formatNag(1), '!');
  assert.equal(formatNag(2), '?');
  assert.equal(formatNag(3), '!!');
  assert.equal(formatNag(4), '??');
  assert.equal(formatNag(5), '!?');
  assert.equal(formatNag(6), '?!');

  // Out of range (positional assessment NAGs like $10, $14) return empty string
  assert.equal(formatNag(0), '');
  assert.equal(formatNag(10), '');
  assert.equal(formatNag(14), '');
  assert.equal(formatNag(100), '');
});

test('formatNags formats multiple NAGs into symbol suffix', () => {
  assert.equal(formatNags([]), '');
  assert.equal(formatNags([1]), '!');
  assert.equal(formatNags([1, 5]), '!!?');
  assert.equal(formatNags([10, 1]), '!');
});

test('parseStartingFen extracts turn and fullmove number', () => {
  const std = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  assert.deepEqual(parseStartingFen(std), { turn: 'w', fullmove: 1 });

  const blackTurn = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  assert.deepEqual(parseStartingFen(blackTurn), { turn: 'b', fullmove: 1 });

  const move3 = 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
  assert.deepEqual(parseStartingFen(move3), { turn: 'b', fullmove: 3 });

  const threeCheckMove12 = '4k3/8/8/8/8/8/8/3R3K b - - 2+3 7 12';
  assert.deepEqual(parseStartingFen(threeCheckMove12, 'threecheck'), { turn: 'b', fullmove: 12 });

  const legacyThreeCheck = '4k3/8/8/8/8/8/8/3R3K b - - 7 12';
  assert.deepEqual(parseStartingFen(legacyThreeCheck, 'threecheck'), { turn: 'b', fullmove: 12 });

  const trailingThreeCheck = '4k3/8/8/8/8/8/8/3R3K b - - 7 12 +1+0';
  assert.deepEqual(parseStartingFen(trailingThreeCheck, 'threecheck'), { turn: 'b', fullmove: 12 });
});

test('buildMoveTree constructs mainline chain, variations, and orders by orderIndex', () => {
  const flat: TreeNodeView[] = [
    { id: 'n1', chapterId: 'c1', parentId: null, san: 'e4', fenAfter: 'fen1', nags: [1], orderIndex: 0 },
    { id: 'n2', chapterId: 'c1', parentId: 'n1', san: 'e5', fenAfter: 'fen2', nags: [], orderIndex: 0 },
    { id: 'n3', chapterId: 'c1', parentId: 'n2', san: 'Nf3', fenAfter: 'fen3', nags: [], orderIndex: 0 },
    { id: 'n4', chapterId: 'c1', parentId: 'n3', san: 'Nc6', fenAfter: 'fen4', nags: [], orderIndex: 0 },
    // Variation branching off n3 (alternative to Nc6, orderIndex 1)
    { id: 'n5', chapterId: 'c1', parentId: 'n3', san: 'Nf6', fenAfter: 'fen5', nags: [], orderIndex: 1 },
  ];

  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const tree = buildMoveTree(flat, fen);

  assert.equal(tree.length, 1);
  const n1 = tree[0]!;
  assert.equal(n1.node.san, 'e4');
  assert.equal(n1.turn, 'w');
  assert.equal(n1.fullmove, 1);

  const n2 = n1.mainline!;
  assert.equal(n2.node.san, 'e5');
  assert.equal(n2.turn, 'b');
  assert.equal(n2.fullmove, 1);

  const n3 = n2.mainline!;
  assert.equal(n3.node.san, 'Nf3');
  assert.equal(n3.turn, 'w');
  assert.equal(n3.fullmove, 2);

  const n4 = n3.mainline!;
  assert.equal(n4.node.san, 'Nc6');
  assert.equal(n4.turn, 'b');
  assert.equal(n4.fullmove, 2);

  // Variation n5 off n3
  assert.equal(n3.variations.length, 1);
  const n5 = n3.variations[0]!;
  assert.equal(n5.node.san, 'Nf6');
  assert.equal(n5.turn, 'b');
  assert.equal(n5.fullmove, 2);
});

test('move numbering formats variation starting on Black move as 3... Nf6, not 3. Nf6', () => {
  // Turn 'b', fullmove 3 at start of branch
  const prefixVariationBlack = formatMovePrefix('b', 3, { isStartOfBranch: true, afterCommentOrVariation: false });
  assert.equal(prefixVariationBlack, '3... ');

  // Turn 'b', fullmove 3 after variation or comment
  const prefixResumedBlack = formatMovePrefix('b', 3, { isStartOfBranch: false, afterCommentOrVariation: true });
  assert.equal(prefixResumedBlack, '3... ');

  // Turn 'b', fullmove 3 inline directly after White move
  const prefixInlineBlack = formatMovePrefix('b', 3, { isStartOfBranch: false, afterCommentOrVariation: false });
  assert.equal(prefixInlineBlack, '');

  // Turn 'w', fullmove 3 always gets '3. '
  const prefixWhite = formatMovePrefix('w', 3, { isStartOfBranch: true, afterCommentOrVariation: false });
  assert.equal(prefixWhite, '3. ');
});
