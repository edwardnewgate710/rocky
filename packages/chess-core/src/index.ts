/**
 * @packageDocumentation
 * `@chess-platform/core` — a fully-typed, variant-aware chess rules engine.
 *
 * Public API:
 * - {@link Position}: immutable position with legal move generation, SAN/UCI,
 *   game-status detection, and `perft`.
 * - FEN helpers, board math, and low-level move generation for advanced use.
 */

export * from './types';
export * from './board';
export * from './fen';
export {
  CHESS960_POSITIONS,
  CHESS960_STANDARD_ID,
  chess960BackRank,
  chess960Fen,
} from './chess960';
// The rights bookkeeping stays internal. What is published is the vocabulary a caller needs to
// read a `PositionState`, plus the FEN castling codec so the spelling can be exercised directly.
export {
  NO_CASTLING_ROOK,
  castledKingSquare,
  castledRookSquare,
  formatCastlingField,
  parseCastlingField,
} from './castling';
// Deliberately not `export *`. The field-shape predicates and the counter-field parsers are how
// the codec reads a FEN, and `check-counters.ts` exists so that the conversion lives in one
// place; publishing them invites a second one. Raised in the CodeRabbit review of PR #140.
export { THREE_CHECK_LIMIT, deliveredFromRemaining, remainingFromDelivered } from './check-counters';
export type { CheckCounters } from './check-counters';
export {
  findKing,
  inCheck,
  isSquareAttacked,
  generatePseudoLegal,
  generateLegalMoves,
  applyMove,
} from './movegen';
export { Position, IllegalMoveError, HORDE_FEN, RACING_KINGS_FEN } from './position';
export { repetitionKey } from './repetition';
