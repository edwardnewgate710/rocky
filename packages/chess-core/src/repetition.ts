/**
 * @packageDocumentation
 * Repetition-key derivation for threefold-repetition detection.
 *
 * The key includes every state element that affects legal moves or game
 * outcomes: board placement, side to move, castling rights, Crazyhouse
 * pockets, and Three-Check counters. Halfmove and fullmove counters are
 * excluded so positions that differ only in move counters still count as
 * repeats.
 *
 * En-passant is special: a FEN may carry an en-passant target square even
 * when no legal en-passant capture exists (e.g. the only pawn that could
 * capture is pinned). In that case the position is equivalent to the same
 * position with "-", so the ep square is normalised to "-" in the key.
 */

import { MoveFlag, type PositionState } from './types';
import { generateLegalMoves } from './movegen';
import { toFen } from './fen';

/**
 * Derive a repetition key from a {@link PositionState}.
 *
 * The key is the first four FEN fields (piece placement, side to move,
 * castling rights, en-passant square) with the en-passant square normalised
 * to "-" when no legal en-passant capture exists. For Crazyhouse the pocket
 * pieces are part of the placement field and are therefore included. For
 * Three-Check the check counters are appended as an extra component.
 */
export function repetitionKey(state: PositionState): string {
  const fields = toFen(state).split(' ');
  // fields: [placement, turn, castling, ep, halfmoves, fullmoves]
  let ep = fields[3];
  if (ep !== '-') {
    // Check whether any legal move is an en-passant capture.
    const hasLegalEp = generateLegalMoves(state).some(
      (m) => (m.flags & MoveFlag.EnPassant) !== 0,
    );
    if (!hasLegalEp) ep = '-';
  }
  let key = `${fields[0]} ${fields[1]} ${fields[2]} ${ep}`;
  // Three-Check counters are persistent variant state that affects the
  // outcome (a player wins on 3 checks). Include them in the key.
  if (state.variant === 'threecheck') {
    key += ` ${state.checkCount.w}+${state.checkCount.b}`;
  }
  return key;
}
