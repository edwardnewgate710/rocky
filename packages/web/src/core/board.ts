/**
 * Dependency-free board geometry for the web board UI.
 *
 * The domain rules live in `@chess-platform/core`; this module only handles the
 * *presentation* concerns the board component needs: mapping between algebraic
 * squares, 0x88-free 0..63 indices, pixel geometry, and orientation. It never
 * decides legality — it is pure view math.
 */

export type Color = 'white' | 'black';

/** Files a..h, ranks 1..8. A square is its algebraic name, e.g. "e4". */
export type Square = string;

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;

/** True for a syntactically valid algebraic square like "a1".."h8". */
export function isSquare(value: string): value is Square {
  return (
    value.length === 2 &&
    value.charCodeAt(0) >= 97 &&
    value.charCodeAt(0) <= 104 &&
    value.charCodeAt(1) >= 49 &&
    value.charCodeAt(1) <= 56
  );
}

/** File index 0..7 (a=0). */
export function fileIndex(square: Square): number {
  return square.charCodeAt(0) - 97;
}

/** Rank index 0..7 (rank 1 = 0). */
export function rankIndex(square: Square): number {
  return square.charCodeAt(1) - 49;
}

/** Build a square from file/rank indices (0..7). Throws if out of range. */
export function toSquare(file: number, rank: number): Square {
  if (file < 0 || file > 7 || rank < 0 || rank > 7) {
    throw new RangeError(`file/rank out of range: ${file},${rank}`);
  }
  return `${FILES[file]}${rank + 1}`;
}

/** Board rows, top-to-bottom, for the given orientation. Row 0 renders first. */
export function ranksForOrientation(orientation: Color): number[] {
  const ascending = [0, 1, 2, 3, 4, 5, 6, 7];
  return orientation === 'white' ? [...ascending].reverse() : ascending;
}

/** Board columns, left-to-right, for the given orientation. */
export function filesForOrientation(orientation: Color): number[] {
  const ascending = [0, 1, 2, 3, 4, 5, 6, 7];
  return orientation === 'white' ? ascending : [...ascending].reverse();
}

/** Light/dark colour of a square, for tinting. */
export function squareShade(square: Square): 'light' | 'dark' {
  return (fileIndex(square) + rankIndex(square)) % 2 === 0 ? 'dark' : 'light';
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Top-left pixel position of a square within a board of `boardSize` px,
 * honouring orientation. Used for absolute-positioning pieces so they can be
 * transform-animated between squares.
 */
export function squareToPixel(square: Square, boardSize: number, orientation: Color): Point {
  const cell = boardSize / 8;
  const files = filesForOrientation(orientation);
  const ranks = ranksForOrientation(orientation);
  const col = files.indexOf(fileIndex(square));
  const row = ranks.indexOf(rankIndex(square));
  return { x: col * cell, y: row * cell };
}

/**
 * Reverse of {@link squareToPixel}: the square under a pointer at (x,y) relative
 * to the board's top-left, or null if outside the board. Powers drag + click.
 */
export function pixelToSquare(
  point: Point,
  boardSize: number,
  orientation: Color,
): Square | null {
  if (point.x < 0 || point.y < 0 || point.x >= boardSize || point.y >= boardSize) {
    return null;
  }
  const cell = boardSize / 8;
  const col = Math.floor(point.x / cell);
  const row = Math.floor(point.y / cell);
  const file = filesForOrientation(orientation)[col];
  const rank = ranksForOrientation(orientation)[row];
  if (file === undefined || rank === undefined) return null;
  return toSquare(file, rank);
}
