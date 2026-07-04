/**
 * @packageDocumentation
 * FEN (Forsyth–Edwards Notation) parsing and serialization.
 *
 * Standard FEN plus a Crazyhouse extension: pocket pieces are appended to the
 * piece-placement field in brackets, e.g. `rnbqkbnr/...[NPp] w ...`.
 */

import { CastleRight, type Piece, type PieceType, type PositionState, type Variant } from './types';
import { emptyBoard, makeSquare, squareFromName, squareName, rankOf } from './board';

/** The standard starting position FEN. */
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const PIECE_CHARS = new Set(['p', 'n', 'b', 'r', 'q', 'k', 'P', 'N', 'B', 'R', 'Q', 'K']);

/** Thrown when a FEN string is malformed. */
export class FenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FenError';
  }
}

/**
 * Parse a FEN string into a {@link PositionState}.
 * @param fen The FEN string.
 * @param variant The rule set this position belongs to.
 */
export function parseFen(fen: string, variant: Variant = 'standard'): PositionState {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) {
    throw new FenError(`FEN must have at least 4 fields, got ${parts.length}: "${fen}"`);
  }
  const [placementRaw, turnRaw, castlingRaw, epRaw] = parts;
  const halfmoves = parts[4] !== undefined ? Number(parts[4]) : 0;
  const fullmoves = parts[5] !== undefined ? Number(parts[5]) : 1;

  const pockets: { w: PieceType[]; b: PieceType[] } = { w: [], b: [] };
  let placement = placementRaw;
  const bracket = placement.indexOf('[');
  if (bracket !== -1) {
    const pocketStr = placement.slice(bracket + 1, placement.indexOf(']'));
    for (const ch of pocketStr) {
      if (ch === ch.toUpperCase()) pockets.w.push(ch.toLowerCase() as PieceType);
      else pockets.b.push(ch as PieceType);
    }
    placement = placement.slice(0, bracket);
  }

  const board = emptyBoard();
  const rows = placement.split('/');
  if (rows.length !== 8) {
    throw new FenError(`FEN placement must have 8 ranks, got ${rows.length}`);
  }
  for (let r = 0; r < 8; r++) {
    const row = rows[r];
    const rank = 7 - r; // FEN lists rank 8 first
    let file = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch);
      } else if (PIECE_CHARS.has(ch)) {
        if (file > 7) throw new FenError(`Rank ${rank + 1} overflows in FEN`);
        board[makeSquare(file, rank)] = ch as Piece;
        file++;
      } else {
        throw new FenError(`Illegal character '${ch}' in FEN placement`);
      }
    }
    if (file !== 8) throw new FenError(`Rank ${rank + 1} does not fill 8 files`);
  }

  if (turnRaw !== 'w' && turnRaw !== 'b') {
    throw new FenError(`Side to move must be 'w' or 'b', got '${turnRaw}'`);
  }

  let castling = 0;
  if (castlingRaw !== '-') {
    for (const ch of castlingRaw) {
      switch (ch) {
        case 'K': castling |= CastleRight.WhiteKing; break;
        case 'Q': castling |= CastleRight.WhiteQueen; break;
        case 'k': castling |= CastleRight.BlackKing; break;
        case 'q': castling |= CastleRight.BlackQueen; break;
        // Chess960 uses file letters (A-H/a-h); handled by the 960 module.
        default: break;
      }
    }
  }

  const epSquare = epRaw === '-' ? -1 : squareFromName(epRaw);

  return {
    board,
    turn: turnRaw,
    castling,
    epSquare,
    halfmoves: Number.isFinite(halfmoves) ? halfmoves : 0,
    fullmoves: Number.isFinite(fullmoves) && fullmoves > 0 ? fullmoves : 1,
    pockets,
    checkCount: { w: 0, b: 0 },
    variant,
  };
}

/** Serialize a {@link PositionState} back to a FEN string. */
export function toFen(state: PositionState): string {
  let placement = '';
  for (let r = 7; r >= 0; r--) {
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const piece = state.board[makeSquare(f, r)];
      if (piece === null) {
        empty++;
      } else {
        if (empty > 0) { placement += String(empty); empty = 0; }
        placement += piece;
      }
    }
    if (empty > 0) placement += String(empty);
    if (r > 0) placement += '/';
  }

  if (state.variant === 'crazyhouse') {
    const pocket =
      state.pockets.w.map((p: PieceType) => p.toUpperCase()).join('') +
      state.pockets.b.join('');
    placement += `[${pocket}]`;
  }

  let castling = '';
  if (state.castling & CastleRight.WhiteKing) castling += 'K';
  if (state.castling & CastleRight.WhiteQueen) castling += 'Q';
  if (state.castling & CastleRight.BlackKing) castling += 'k';
  if (state.castling & CastleRight.BlackQueen) castling += 'q';
  if (castling === '') castling = '-';

  const ep = state.epSquare === -1 ? '-' : squareName(state.epSquare);

  return `${placement} ${state.turn} ${castling} ${ep} ${state.halfmoves} ${state.fullmoves}`;
}

/** Deep-clone a position state (used before mutation to preserve immutability). */
export function cloneState(state: PositionState): PositionState {
  return {
    board: state.board.slice(),
    turn: state.turn,
    castling: state.castling,
    epSquare: state.epSquare,
    halfmoves: state.halfmoves,
    fullmoves: state.fullmoves,
    pockets: { w: state.pockets.w.slice(), b: state.pockets.b.slice() },
    checkCount: { w: state.checkCount.w, b: state.checkCount.b },
    variant: state.variant,
  };
}

/** True if the FEN's rank layout is otherwise valid but we only need side info. */
export function fenRankOf(sq: number): number {
  return rankOf(sq);
}
