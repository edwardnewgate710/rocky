/**
 * CoreMoveOracle — a {@link LegalMoveOracle} adapter backed by
 * {@link import('@chess-platform/core')} for instant local legality feedback.
 *
 * The server remains authoritative for the moves that actually count, but this
 * oracle gives the UI responsive destination highlighting and premove validation
 * without a round-trip. It is wired at the composition root and reconciled with
 * the authoritative server state via GameSync.
 *
 * This is the only place in the web package that imports @chess-platform/core.
 */
import {
  type Position,
  parseFen,
  makeBoard,
  legalDestinations,
  fen,
} from '@chess-platform/core';
import type { Square } from '../core/board.js';
import type { LegalMoveOracle } from './move-oracle.js';

/**
 * Oracle that wraps @chess-platform/core to compute legal destinations.
 * Lightweight: parses the FEN once on setPosition, then queries in O(1) per
 * square via precomputed lookup.
 */
export class CoreMoveOracle implements LegalMoveOracle {
  private pos: Position | null = null;
  private destCache: Map<Square, readonly Square[]> = new Map();

  setPosition(fenStr: string): void {
    try {
      this.pos = parseFen(fenStr);
      this.destCache = new Map();
    } catch {
      this.pos = null;
      this.destCache = new Map();
    }
  }

  destinations(from: Square): readonly Square[] {
    const cached = this.destCache.get(from);
    if (cached !== undefined) return cached;

    if (!this.pos) return [];

    const board = makeBoard(this.pos);
    const results = legalDestinations(board, from);
    this.destCache.set(from, results);
    return results;
  }

  /** Current FEN of the oracle’s position, or the starting FEN if unset. */
  currentFen(): string {
    return this.pos ? fen(this.pos) : 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  }
}
