/**
 * @packageDocumentation
 * Deterministic Chess960 (Fischer Random Chess) starting-position generator
 * implementing Reinhard Scharnagl's 0..959 numbering scheme.
 */

/** The number of distinct Chess960 starting arrangements. */
export const CHESS960_POSITIONS = 960;

/** The Scharnagl id of the traditional chess array (RNBQKBNR). */
export const CHESS960_STANDARD_ID = 518;

/**
 * The ten combinations of choosing two slots out of five empty files (C(5, 2)),
 * ordered lexicographically by slot index.
 */
const KNIGHT_PAIRS: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, 2],
  [0, 3],
  [0, 4],
  [1, 2],
  [1, 3],
  [1, 4],
  [2, 3],
  [2, 4],
  [3, 4],
];

/**
 * The back-rank arrangement for Scharnagl starting-position id `id` (0..959),
 * as eight uppercase piece letters, file a first: e.g. id 518 -> "RNBQKBNR".
 */
export function chess960BackRank(id: number): string {
  if (!Number.isInteger(id) || id < 0 || id >= CHESS960_POSITIONS) {
    throw new RangeError(`Invalid Chess960 starting-position id: ${id}`);
  }

  const rank: (string | undefined)[] = new Array<string | undefined>(8);

  // 1. Light-square bishop on file b, d, f, or h.
  const n2 = Math.floor(id / 4);
  const b1 = id % 4;
  rank[2 * b1 + 1] = 'B';

  // 2. Dark-square bishop on file a, c, e, or g.
  const n3 = Math.floor(n2 / 4);
  const b2 = n2 % 4;
  rank[2 * b2] = 'B';

  // 3. Queen placed on the q-th unoccupied file (0-indexed).
  const n4 = Math.floor(n3 / 6);
  const q = n3 % 6;
  let emptyCount = 0;
  for (let file = 0; file < 8; file++) {
    if (rank[file] === undefined) {
      if (emptyCount === q) {
        rank[file] = 'Q';
        break;
      }
      emptyCount++;
    }
  }

  // 4. Knights placed on the pair of slots selected by n4 among the 5 remaining empty files.
  const pair = KNIGHT_PAIRS[n4];
  if (!pair) {
    throw new RangeError(`Invalid Chess960 starting-position id: ${id}`);
  }
  const [k1, k2] = pair;

  const emptyFiles: number[] = [];
  for (let file = 0; file < 8; file++) {
    if (rank[file] === undefined) {
      emptyFiles.push(file);
    }
  }
  rank[emptyFiles[k1]] = 'N';
  rank[emptyFiles[k2]] = 'N';

  // 5. Remaining three files receive Rook, King, Rook in file order, preserving
  // the rule that the king must be positioned between the two rooks.
  let remainingCount = 0;
  for (let file = 0; file < 8; file++) {
    if (rank[file] === undefined) {
      if (remainingCount === 0 || remainingCount === 2) {
        rank[file] = 'R';
      } else {
        rank[file] = 'K';
      }
      remainingCount++;
    }
  }

  return rank.join('');
}

/**
 * The full starting FEN for Chess960 starting-position id `id`.
 *
 * Black mirrors White file for file, which is what makes the variant symmetric: both players
 * face the same problem from opposite sides. Pawns stay on ranks 2 and 7 exactly as in standard
 * chess — only the back rank is rearranged.
 *
 * The castling field is written `KQkq` rather than in Shredder file letters. A starting
 * position has exactly one rook on each side of the king, so both rooks are outermost and X-FEN
 * spells them `K` and `Q`; id 518 therefore reproduces the standard opening FEN character
 * for character.
 */
export function chess960Fen(id: number): string {
  const back = chess960BackRank(id);
  return `${back.toLowerCase()}/pppppppp/8/8/8/8/PPPPPPPP/${back} w KQkq - 0 1`;
}
