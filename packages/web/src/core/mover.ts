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

  // Chess960 castling: the king "moves onto" its own rook.
  //
  // Checked before the two-file rule below, and it has to be. Chess960 spells a castle king-takes-rook
  // (ADR-0136 §4), and that spelling can span any distance — `g1h1` is one file, `d1a1` is three, and
  // `d1f1` is exactly two, which the rule below would have read as an ordinary kingside castle and
  // resolved through the wrong rook.
  //
  // No variant flag is needed, because the board already settles it: a king can never capture its own
  // piece, so a king landing on a friendly rook is a castle and nothing else. That keeps this function
  // what it is — a view-only projector with no rules engine behind it.
  //
  // Destinations are the canonical ones: king to g or c, rook to f or d, kingside when the rook starts
  // outside the king. Both pieces are placed here and the function returns early, because the shared
  // `pieces.set(move.to, …)` below would otherwise park the king on the rook's square — which is
  // exactly the bug this replaces. Raised in the CodeRabbit review of PR #12; the client used to
  // project `d1a1` as a king on a1 with the rook gone, so the board went visibly wrong after a live
  // castle broadcast until the next full snapshot.
  const target = pieces.get(move.to);
  if (piece.role === 'k' && target?.role === 'r' && target.color === piece.color) {
    const rank = rankIndex(move.from);
    const kingside = toFile > fromFile;
    pieces.delete(move.to);
    pieces.set(toSquare(kingside ? 6 : 2, rank) as Square, piece);
    pieces.set(toSquare(kingside ? 5 : 3, rank) as Square, target);
    const flipped = side === 'w' ? 'b' : 'w';
    return `${serializePlacement(pieces)} ${flipped} - - 0 1`;
  }

  // Standard castling: king moves two files onto an empty square -> transfer the rook.
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
