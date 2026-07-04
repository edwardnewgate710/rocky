/**
 * @packageDocumentation
 * 0x88 board utilities: square math, piece helpers, and movement offsets.
 */

import type { Color, Piece, PieceType } from './types';

/** True if a 0x88 index refers to a real board square. */
export function onBoard(sq: number): boolean {
  return (sq & 0x88) === 0;
}

/** Rank 0..7 (0 = rank 1) of a 0x88 square. */
export function rankOf(sq: number): number {
  return sq >> 4;
}

/** File 0..7 (0 = a-file) of a 0x88 square. */
export function fileOf(sq: number): number {
  return sq & 7;
}

/** Build a 0x88 index from file (0..7) and rank (0..7). */
export function makeSquare(file: number, rank: number): number {
  return rank * 16 + file;
}

/** Convert algebraic square name (e.g. `"e4"`) to a 0x88 index. */
export function squareFromName(name: string): number {
  const file = name.charCodeAt(0) - 97; // 'a'
  const rank = name.charCodeAt(1) - 49; // '1'
  return makeSquare(file, rank);
}

/** Convert a 0x88 index to an algebraic square name (e.g. `"e4"`). */
export function squareName(sq: number): string {
  return String.fromCharCode(97 + fileOf(sq)) + String.fromCharCode(49 + rankOf(sq));
}

/** Color of a piece character. */
export function colorOf(piece: Piece): Color {
  return piece === piece.toUpperCase() ? 'w' : 'b';
}

/** Lowercase kind of a piece character. */
export function typeOf(piece: Piece): PieceType {
  return piece.toLowerCase() as PieceType;
}

/** Compose a piece character from color + kind. */
export function makePiece(color: Color, type: PieceType): Piece {
  return (color === 'w' ? type.toUpperCase() : type) as Piece;
}

/** The opposite color. */
export function opposite(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}

// --- Movement offset tables (0x88) ---------------------------------------

/** Knight jump offsets. */
export const KNIGHT_OFFSETS: readonly number[] = [33, 31, 18, 14, -33, -31, -18, -14];

/** King (and single-step queen) offsets. */
export const KING_OFFSETS: readonly number[] = [16, -16, 1, -1, 17, 15, -17, -15];

/** Rook sliding directions. */
export const ROOK_OFFSETS: readonly number[] = [16, -16, 1, -1];

/** Bishop sliding directions. */
export const BISHOP_OFFSETS: readonly number[] = [17, 15, -17, -15];

/** Queen sliding directions (rook + bishop). */
export const QUEEN_OFFSETS: readonly number[] = [16, -16, 1, -1, 17, 15, -17, -15];

/** Create an empty 0x88 board (128 nulls). */
export function emptyBoard(): (Piece | null)[] {
  return new Array<Piece | null>(128).fill(null);
}
