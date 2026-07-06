/**
 * Authoritative move oracle — a {@link LegalMoveOracle} adapter fed by the
 * authoritative `legalMoves` map in {@link GameSyncState}.
 *
 * This adapter contains no chess rules. It reads the legal-move map that the
 * server (via the realtime gateway's `GameAuthority` and the perft-verified
 * core engine) embeds in every {@link StateView} snapshot. The map is keyed by
 * origin square (algebraic notation, e.g. `"e2"`) with values being arrays of
 * legal destination squares. It is empty (`{}`) once the game is over and is
 * stale after a live move broadcast until the next snapshot/resync refreshes it.
 *
 * The adapter is wired at the composition root (increment 3C-2C) so the
 * interaction layer can query `destinations(from)` for highlight rendering and
 * premove validation without importing `@chess-platform/core`.
 */
import type { LegalMoveOracle } from '../ports/move-oracle.js';
import type { Square } from '../core/board.js';
import type { LegalMoves } from './ws-protocol.js';

/**
 * Options for constructing an {@link AuthoritativeMoveOracle}.
 */
export interface AuthoritativeMoveOracleOptions {
  /**
   * A function that returns the current authoritative `legalMoves` map from
   * `GameSync` state. This is typically `() => gameSync.getState().legalMoves`.
   */
  readonly getLegalMoves: () => LegalMoves;
}

/**
 * `LegalMoveOracle` adapter backed by the authoritative server snapshot.
 *
 * Call {@link AuthoritativeMoveOracle.setPosition} to point the oracle at a FEN
 * (the adapter uses it only to signal a position change; legality data comes
 * exclusively from the `legalMoves` map). Then call
 * {@link AuthoritativeMoveOracle.destinations} to query legal destination
 * squares for an origin square.
 */
export class AuthoritativeMoveOracle implements LegalMoveOracle {
  private readonly getLegalMoves: () => LegalMoves;

  constructor(options: AuthoritativeMoveOracleOptions) {
    this.getLegalMoves = options.getLegalMoves;
  }

  setPosition(_fen: string): void {
    // The legal-move map is sourced from the authoritative snapshot; the FEN
    // is accepted to satisfy the port contract but not used for computation.
  }

  destinations(from: Square): readonly Square[] {
    const moves = this.getLegalMoves();
    return moves[from] ?? [];
  }
}
