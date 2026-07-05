/**
 * View-only optimistic mover.
 *
 * Applies an ALREADY-CHOSEN move to the placement for instant UI feedback while
 * the server confirms (optimistic update, reconciled on the authoritative
 * event). This is NOT a rules engine: it does not decide legality, check, or
 * game end — it only reflects a known move (including capture, promotion,
 * castling rook transfer, and en-passant capture) so the board updates
 * immediately. Legality stays with `@chess-platform/core` / the server.
 */
import { fileIndex, rankIndex, toSquare, type Square } from './board.js';
import { parsePlacement, type Piece, type PieceColor } from './position.js';
import type { Premove } from './premove.js';

function letter(p: Piece): string {
  return p.color === 'w' ? p.role.toUpperCase() : p.role;
}

/** Serialize a square->piece map back into a FEN placement field. */
export function serializePlacement(pieces: ReadonlyMap<Square, Piece>): string {
  const rows: string[] = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = '';
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const p = pieces.get(toSquare(file, rank));
      if (p) {
        if (empty) {
          row += String(empty);
          empty = 0;
        }
        row += letter(p);
      } else {
        empty += 1;
      }
    }
    if (empty) row += String(empty);
    rows.push(row);
  }
  return rows.join('/');
}

/**
 * Apply `move` to `fen`, returning a new FEN. Only the placement and side-to-move
 * fields are meaningful; castling/en-passant/counters are reset (`- - 0 1`)
 * since this is a view-only projection, not the authoritative game state.
 */
export function applyMove(fen: string, move: Premove): string {
  const pieces = new Map(parsePlacement(fen));
  const side = fen.trim().split(/\s+/)[1] === 'b' ? 'b' : 'w';
  const piece = pieces.get(move.from);
  if (!piece) return fen;

  pieces.delete(move.from);

  const fromFile = fileIndex(move.from);
  const toFile = fileIndex(move.to);
  const toRank = rankIndex(move.to);

  // En-passant capture: pawn changes file onto an empty square.
  if (piece.role === 'p' && fromFile !== toFile && !pieces.has(move.to)) {
    const capturedRank = rankIndex(move.from);
    pieces.delete(toSquare(toFile, capturedRank) as Square);
  }

  // Castling: king moves two files -> transfer the rook.
  if (piece.role === 'k' && Math.abs(toFile - fromFile) === 2) {
    const rank = rankIndex(move.from);
    if (toFile === 6) {
      const rook = pieces.get(toSquare(7, rank));
      pieces.delete(toSquare(7, rank));
      if (rook) pieces.set(toSquare(5, rank), rook);
    } else if (toFile === 2) {
      const rook = pieces.get(toSquare(0, rank));
      pieces.delete(toSquare(0, rank));
      if (rook) pieces.set(toSquare(3, rank), rook);
    }
  }

  const placed: Piece =
    move.promotion && piece.role === 'p'
      ? { color: piece.color as PieceColor, role: move.promotion }
      : piece;
  pieces.set(move.to, placed);

  const nextSide = side === 'w' ? 'b' : 'w';
  return `${serializePlacement(pieces)} ${nextSide} - - 0 1`;
}
