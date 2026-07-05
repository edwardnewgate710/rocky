/**
 * View-only FEN placement parsing.
 *
 * The board component needs to know *which piece sits on which square* to render
 * it. Full FEN semantics (castling, en passant, legality) belong to
 * `@chess-platform/core`; here we only decode the piece-placement field into a
 * square→piece map so rendering has no dependency on the rules engine.
 */
import { toSquare, type Square } from './board.js';

export type PieceColor = 'w' | 'b';
export type PieceRole = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';

export interface Piece {
  readonly color: PieceColor;
  readonly role: PieceRole;
}

export const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const ROLES = new Set(['p', 'n', 'b', 'r', 'q', 'k']);

/**
 * Parse the placement field (first FEN token) into a map of occupied squares.
 * Throws on structurally invalid placement so callers fail fast.
 */
export function parsePlacement(fen: string): Map<Square, Piece> {
  const placement = fen.trim().split(/\s+/)[0] ?? '';
  const rows = placement.split('/');
  if (rows.length !== 8) {
    throw new Error(`FEN placement must have 8 ranks, got ${rows.length}`);
  }
  const board = new Map<Square, Piece>();
  for (let r = 0; r < 8; r++) {
    const rank = 7 - r; // FEN lists rank 8 first
    let file = 0;
    for (const ch of rows[r] ?? '') {
      if (ch >= '1' && ch <= '8') {
        file += ch.charCodeAt(0) - 48;
        continue;
      }
      const lower = ch.toLowerCase();
      if (!ROLES.has(lower)) {
        throw new Error(`invalid FEN piece '${ch}'`);
      }
      if (file > 7) {
        throw new Error(`FEN rank ${rank + 1} overflows the board`);
      }
      board.set(toSquare(file, rank), {
        color: ch === lower ? 'b' : 'w',
        role: lower as PieceRole,
      });
      file += 1;
    }
    if (file !== 8) {
      throw new Error(`FEN rank ${rank + 1} does not fill 8 files`);
    }
  }
  return board;
}
