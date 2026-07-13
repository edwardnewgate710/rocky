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
  findKing,
  inCheck,
  isSquareAttacked,
  generatePseudoLegal,
  generateLegalMoves,
  applyMove,
} from './movegen';
export { Position, IllegalMoveError, HORDE_FEN, RACING_KINGS_FEN } from './position';
export { repetitionKey } from './repetition';
