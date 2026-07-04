/**
 * @packageDocumentation
 * Move generation, attack detection, and move application.
 *
 * The public surface is {@link generateLegalMoves} and {@link applyMove}, both
 * pure with respect to their input (they never mutate the argument state).
 * Standard-chess correctness is verified by the `perft` suite against published
 * reference node counts (start position and "Kiwipete").
 */

import {
  BISHOP_OFFSETS,
  KING_OFFSETS,
  KNIGHT_OFFSETS,
  ROOK_OFFSETS,
  colorOf,
  makePiece,
  onBoard,
  opposite,
  rankOf,
  typeOf,
} from './board';
import { cloneState } from './fen';
import {
  CastleRight,
  MoveFlag,
  type Color,
  type Move,
  type Piece,
  type PieceType,
  type PositionState,
} from './types';

const PROMOTION_TYPES: readonly PieceType[] = ['q', 'r', 'b', 'n'];

/** Locate the king of `color`. Returns -1 if there is none (variant edge case). */
export function findKing(state: PositionState, color: Color): number {
  const king = makePiece(color, 'k');
  for (let sq = 0; sq < 128; sq++) {
    if ((sq & 0x88) === 0 && state.board[sq] === king) return sq;
  }
  return -1;
}

/**
 * Is square `sq` attacked by any piece of color `by`?
 * Used for check detection, castling legality, and variant rules.
 */
export function isSquareAttacked(state: PositionState, sq: number, by: Color): boolean {
  const board = state.board;

  // Pawn attacks. A white pawn on x attacks x+15 and x+17.
  if (by === 'w') {
    if (board[sq - 17] === 'P' && onBoard(sq - 17)) return true;
    if (board[sq - 15] === 'P' && onBoard(sq - 15)) return true;
  } else {
    if (board[sq + 17] === 'p' && onBoard(sq + 17)) return true;
    if (board[sq + 15] === 'p' && onBoard(sq + 15)) return true;
  }

  // Knight attacks.
  const knight = makePiece(by, 'n');
  for (const off of KNIGHT_OFFSETS) {
    const t = sq + off;
    if (onBoard(t) && board[t] === knight) return true;
  }

  // King attacks.
  const king = makePiece(by, 'k');
  for (const off of KING_OFFSETS) {
    const t = sq + off;
    if (onBoard(t) && board[t] === king) return true;
  }

  // Sliding: bishop/queen on diagonals.
  const bishop = makePiece(by, 'b');
  const queen = makePiece(by, 'q');
  for (const off of BISHOP_OFFSETS) {
    let t = sq + off;
    while (onBoard(t)) {
      const p = board[t];
      if (p !== null) {
        if (p === bishop || p === queen) return true;
        break;
      }
      t += off;
    }
  }

  // Sliding: rook/queen on ranks/files.
  const rook = makePiece(by, 'r');
  for (const off of ROOK_OFFSETS) {
    let t = sq + off;
    while (onBoard(t)) {
      const p = board[t];
      if (p !== null) {
        if (p === rook || p === queen) return true;
        break;
      }
      t += off;
    }
  }

  return false;
}

/** True if the side `color`'s king is currently in check. */
export function inCheck(state: PositionState, color: Color): boolean {
  const k = findKing(state, color);
  if (k === -1) return false;
  return isSquareAttacked(state, k, opposite(color));
}

function pushMove(list: Move[], m: Move): void {
  list.push(m);
}

/** Generate pseudo-legal moves (may leave own king in check). */
export function generatePseudoLegal(state: PositionState): Move[] {
  const moves: Move[] = [];
  const us = state.turn;
  const them = opposite(us);
  const board = state.board;
  const forward = us === 'w' ? 16 : -16;
  const startRank = us === 'w' ? 1 : 6;
  const promoRank = us === 'w' ? 7 : 0;

  for (let from = 0; from < 128; from++) {
    if ((from & 0x88) !== 0) continue;
    const piece = board[from];
    if (piece === null || colorOf(piece) !== us) continue;
    const kind = typeOf(piece);

    switch (kind) {
      case 'p': {
        // Single push.
        const one = from + forward;
        if (onBoard(one) && board[one] === null) {
          if (rankOf(one) === promoRank) {
            for (const promo of PROMOTION_TYPES) {
              pushMove(moves, { from, to: one, piece, promotion: promo, flags: MoveFlag.Promotion });
            }
          } else {
            pushMove(moves, { from, to: one, piece, flags: MoveFlag.Normal });
            // Double push.
            if (rankOf(from) === startRank) {
              const two = from + forward * 2;
              if (board[two] === null) {
                pushMove(moves, { from, to: two, piece, flags: MoveFlag.DoublePawnPush });
              }
            }
          }
        }
        // Captures (including en passant).
        for (const diag of us === 'w' ? [15, 17] : [-15, -17]) {
          const to = from + diag;
          if (!onBoard(to)) continue;
          const target = board[to];
          if (target !== null && colorOf(target) === them) {
            if (rankOf(to) === promoRank) {
              for (const promo of PROMOTION_TYPES) {
                pushMove(moves, {
                  from, to, piece, captured: target, promotion: promo,
                  flags: MoveFlag.Capture | MoveFlag.Promotion,
                });
              }
            } else {
              pushMove(moves, { from, to, piece, captured: target, flags: MoveFlag.Capture });
            }
          } else if (to === state.epSquare && state.epSquare !== -1) {
            const capturedSq = to - forward;
            pushMove(moves, {
              from, to, piece, captured: board[capturedSq] as Piece,
              flags: MoveFlag.Capture | MoveFlag.EnPassant,
            });
          }
        }
        break;
      }

      case 'n': {
        for (const off of KNIGHT_OFFSETS) {
          const to = from + off;
          if (!onBoard(to)) continue;
          const target = board[to];
          if (target === null) {
            pushMove(moves, { from, to, piece, flags: MoveFlag.Normal });
          } else if (colorOf(target) === them) {
            pushMove(moves, { from, to, piece, captured: target, flags: MoveFlag.Capture });
          }
        }
        break;
      }

      case 'k': {
        for (const off of KING_OFFSETS) {
          const to = from + off;
          if (!onBoard(to)) continue;
          const target = board[to];
          if (target === null) {
            pushMove(moves, { from, to, piece, flags: MoveFlag.Normal });
          } else if (colorOf(target) === them) {
            pushMove(moves, { from, to, piece, captured: target, flags: MoveFlag.Capture });
          }
        }
        generateCastles(state, from, piece, moves);
        break;
      }

      case 'b': generateSliding(state, from, piece, BISHOP_OFFSETS, moves); break;
      case 'r': generateSliding(state, from, piece, ROOK_OFFSETS, moves); break;
      case 'q': generateSliding(state, from, piece, KING_OFFSETS, moves); break;
    }
  }

  // Crazyhouse drops.
  if (state.variant === 'crazyhouse') {
    generateDrops(state, moves);
  }

  return moves;
}

function generateSliding(
  state: PositionState,
  from: number,
  piece: Piece,
  offsets: readonly number[],
  moves: Move[],
): void {
  const board = state.board;
  const them = opposite(colorOf(piece));
  for (const off of offsets) {
    let to = from + off;
    while (onBoard(to)) {
      const target = board[to];
      if (target === null) {
        pushMove(moves, { from, to, piece, flags: MoveFlag.Normal });
      } else {
        if (colorOf(target) === them) {
          pushMove(moves, { from, to, piece, captured: target, flags: MoveFlag.Capture });
        }
        break;
      }
      to += off;
    }
  }
}

function generateCastles(state: PositionState, from: number, piece: Piece, moves: Move[]): void {
  const us = colorOf(piece);
  const them = opposite(us);
  const board = state.board;
  // Racing kings has no castling; king must never be in/near check anyway.
  if (state.variant === 'racingkings' || state.variant === 'horde') return;

  const homeKing = us === 'w' ? 4 : 116;
  if (from !== homeKing) return;
  if (isSquareAttacked(state, from, them)) return; // can't castle out of check

  const kingRight = us === 'w' ? CastleRight.WhiteKing : CastleRight.BlackKing;
  const queenRight = us === 'w' ? CastleRight.WhiteQueen : CastleRight.BlackQueen;

  if (state.castling & kingRight) {
    const f = from + 1, g = from + 2, rookSq = from + 3;
    if (
      board[f] === null && board[g] === null &&
      board[rookSq] === makePiece(us, 'r') &&
      !isSquareAttacked(state, f, them) && !isSquareAttacked(state, g, them)
    ) {
      pushMove(moves, { from, to: g, piece, flags: MoveFlag.KingCastle });
    }
  }
  if (state.castling & queenRight) {
    const d = from - 1, c = from - 2, b = from - 3, rookSq = from - 4;
    if (
      board[d] === null && board[c] === null && board[b] === null &&
      board[rookSq] === makePiece(us, 'r') &&
      !isSquareAttacked(state, d, them) && !isSquareAttacked(state, c, them)
    ) {
      pushMove(moves, { from, to: c, piece, flags: MoveFlag.QueenCastle });
    }
  }
}

function generateDrops(state: PositionState, moves: Move[]): void {
  const us = state.turn;
  const pocket = state.pockets[us];
  const seen = new Set<PieceType>();
  for (const type of pocket) {
    if (seen.has(type)) continue;
    seen.add(type);
    for (let to = 0; to < 128; to++) {
      if ((to & 0x88) !== 0) continue;
      if (state.board[to] !== null) continue;
      // Pawns may not be dropped on the 1st or 8th rank.
      if (type === 'p') {
        const r = rankOf(to);
        if (r === 0 || r === 7) continue;
      }
      moves.push({ from: -1, to, piece: makePiece(us, type), drop: type, flags: MoveFlag.Normal });
    }
  }
}

/**
 * Apply a move to a *copy* of `state` and return the new state. The input state
 * is never mutated. Handles captures, promotions, en passant, castling,
 * castling-right updates, halfmove/fullmove clocks, and variant side effects.
 */
export function applyMove(state: PositionState, move: Move): PositionState {
  const next = cloneState(state);
  const board = next.board;
  const us = state.turn;
  const them = opposite(us);

  next.epSquare = -1;

  if (move.drop) {
    // Crazyhouse drop.
    board[move.to] = move.piece;
    const idx = next.pockets[us].indexOf(move.drop);
    if (idx !== -1) next.pockets[us].splice(idx, 1);
    next.halfmoves = 0;
  } else {
    const movingPiece = board[move.from];
    board[move.from] = null;

    // Handle capture bookkeeping (pocket for crazyhouse).
    if (move.flags & MoveFlag.EnPassant) {
      const capturedSq = move.to - (us === 'w' ? 16 : -16);
      const capd = board[capturedSq];
      board[capturedSq] = null;
      if (next.variant === 'crazyhouse' && capd) next.pockets[us].push('p');
    } else if (move.captured) {
      if (next.variant === 'crazyhouse') {
        // Demoted pieces return as pawns per Crazyhouse rules.
        next.pockets[us].push(typeOf(move.captured));
      }
    }

    // Place piece (with promotion).
    if (move.promotion) {
      board[move.to] = makePiece(us, move.promotion);
    } else {
      board[move.to] = movingPiece;
    }

    // Castling: move the rook too.
    if (move.flags & MoveFlag.KingCastle) {
      const rookFrom = move.from + 3, rookTo = move.from + 1;
      board[rookTo] = board[rookFrom];
      board[rookFrom] = null;
    } else if (move.flags & MoveFlag.QueenCastle) {
      const rookFrom = move.from - 4, rookTo = move.from - 1;
      board[rookTo] = board[rookFrom];
      board[rookFrom] = null;
    }

    // Double pawn push sets the en-passant target.
    if (move.flags & MoveFlag.DoublePawnPush) {
      next.epSquare = move.from + (us === 'w' ? 16 : -16);
    }

    // Halfmove clock: reset on pawn move or capture.
    if (typeOf(move.piece) === 'p' || move.captured) next.halfmoves = 0;
    else next.halfmoves = state.halfmoves + 1;

    // Update castling rights.
    next.castling = updateCastlingRights(state.castling, move);

    // Atomic explosion.
    if (next.variant === 'atomic' && move.captured) {
      explode(next, move.to);
    }
  }

  // Three-check accounting.
  if (next.variant === 'threecheck') {
    if (inCheck(next, them)) next.checkCount[us] += 1;
  }

  next.turn = them;
  if (us === 'b') next.fullmoves = state.fullmoves + 1;
  return next;
}

function updateCastlingRights(rights: number, move: Move): number {
  let r = rights;
  // King moves remove both rights for that color.
  const t = typeOf(move.piece);
  const c = colorOf(move.piece);
  if (t === 'k') {
    r &= c === 'w'
      ? ~(CastleRight.WhiteKing | CastleRight.WhiteQueen)
      : ~(CastleRight.BlackKing | CastleRight.BlackQueen);
  }
  // Rook leaving its home square, or being captured on it, clears that right.
  const clearFor = (sq: number) => {
    switch (sq) {
      case 7: r &= ~CastleRight.WhiteKing; break;   // h1
      case 0: r &= ~CastleRight.WhiteQueen; break;  // a1
      case 119: r &= ~CastleRight.BlackKing; break; // h8
      case 112: r &= ~CastleRight.BlackQueen; break;// a8
    }
  };
  clearFor(move.from);
  clearFor(move.to);
  return r;
}

/** Atomic: remove the captured piece, the capturer, and all adjacent non-pawns. */
function explode(state: PositionState, at: number): void {
  const board = state.board;
  board[at] = null; // capturer
  for (const off of KING_OFFSETS) {
    const sq = at + off;
    if (!onBoard(sq)) continue;
    const p = board[sq];
    if (p !== null && typeOf(p) !== 'p') board[sq] = null;
  }
}

/**
 * Generate fully legal moves for the side to move, respecting the position's
 * variant (check rules, atomic king-adjacency, king-of-the-hill, etc.).
 */
export function generateLegalMoves(state: PositionState): Move[] {
  const pseudo = generatePseudoLegal(state);
  const us = state.turn;
  const legal: Move[] = [];

  for (const move of pseudo) {
    const next = applyMove(state, move);
    if (isLegalAfter(state, next, us)) legal.push(move);
  }
  return legal;
}

function isLegalAfter(before: PositionState, after: PositionState, us: Color): boolean {
  const them = opposite(us);

  if (before.variant === 'atomic') {
    // In atomic, if your own king was blown up, the move is illegal — unless the
    // enemy king was also destroyed (you win by exploding their king).
    const myKing = findKing(after, us);
    const enemyKing = findKing(after, them);
    if (enemyKing === -1) return true; // you exploded their king → legal & winning
    if (myKing === -1) return false;   // you blew up your own king → illegal
    // Kings may be adjacent; check only matters if delivered by non-king means,
    // but a king cannot capture in atomic (would self-destruct) so ordinary
    // check detection still applies to the surviving king.
    return !isSquareAttacked(after, myKing, them);
  }

  if (before.variant === 'racingkings') {
    // No move may leave *either* king in check (racing kings forbids checks).
    if (inCheck(after, us) || inCheck(after, them)) return false;
    return true;
  }

  // Standard rule: your king must not be in check after your move.
  const myKing = findKing(after, us);
  if (myKing === -1) {
    // Horde's pawn army has no king and therefore no check constraint.
    // Any other kingless side is a terminal/illegal position.
    return before.variant === 'horde';
  }
  return !isSquareAttacked(after, myKing, them);
}
