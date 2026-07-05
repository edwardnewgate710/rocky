/**
 * Legal-move oracle port.
 *
 * The frontend must NOT contain chess rules — legality lives in
 * `@chess-platform/core` and the **server remains authoritative** for the moves
 * that actually count. For responsive UX (destination highlighting, accepting a
 * premove) the interaction layer asks an injected oracle which destinations are
 * legal from a square in the current position. The concrete adapter is wired at
 * the composition root (a `@chess-platform/core`-backed oracle for instant local
 * feedback, reconciled with the server), keeping this package dependency-free
 * and fully unit-testable — the same seam pattern used by the engine package's
 * transport port.
 */
import type { Square } from '../core/board.js';

export interface LegalMoveOracle {
  /**
   * Legal destination squares for a piece on `from` in the current position,
   * or an empty list if the square is empty / has no legal moves. Set the
   * position with {@link LegalMoveOracle.setPosition} first.
   */
  destinations(from: Square): readonly Square[];
  /** Point the oracle at a position (FEN). */
  setPosition(fen: string): void;
}

/** Oracle that never offers a move. Safe default before an adapter is wired. */
export class NullMoveOracle implements LegalMoveOracle {
  setPosition(_fen: string): void {
    /* no-op */
  }
  destinations(_from: Square): readonly Square[] {
    return [];
  }
}

/**
 * Data-driven oracle: legality is supplied as a per-position map, not computed.
 * Used in tests and for wiring precomputed legal moves the server/core provide.
 * It contains no chess rules of its own.
 */
export class StaticMoveOracle implements LegalMoveOracle {
  private byFen: Map<string, Map<Square, readonly Square[]>>;
  private current: Map<Square, readonly Square[]> = new Map();

  constructor(table: Record<string, Record<string, string[]>> = {}) {
    this.byFen = new Map(
      Object.entries(table).map(([fen, moves]) => [
        fen,
        new Map(Object.entries(moves)),
      ]),
    );
  }

  setPosition(fen: string): void {
    this.current = this.byFen.get(fen) ?? new Map();
  }

  destinations(from: Square): readonly Square[] {
    return this.current.get(from) ?? [];
  }
}
