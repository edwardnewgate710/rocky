/**
 * @packageDocumentation
 * The one place that knows Three-Check counters are written one way and stored another.
 *
 * Internally a `PositionState` counts checks **delivered**, upward from zero, because that is what
 * `movegen` increments and what the win condition reads (`checkCount[us] >= 3`). Fairy-Stockfish —
 * and therefore the FEN the outside world expects — counts checks **remaining**, downward from
 * three. The two are the same fact in opposite directions, and the conversion lives here so that
 * `3 - x` never has to appear in a parser, a serializer or an engine adapter, where an off-by-one
 * would be invisible until a game ended early.
 *
 * Verified against Fairy-Stockfish 14 (`fairy_sf_14`): the start position is emitted as
 * `... w KQkq - 3+3 0 1`, and the first value falls as White delivers checks (`3+3` → `2+3` →
 * `1+3`), the second as Black does. See ADR-0120.
 */
import { FenError } from './fen-error';

/**
 * Checks that win a Three-Check game.
 *
 * Named rather than inlined because it is the pivot of every conversion below, and because
 * Fairy-Stockfish also ships a `5check` variant — the number is a property of the rule set, not a
 * universal constant.
 */
export const THREE_CHECK_LIMIT = 3;

/** Delivered-check counts, as a `PositionState` stores them. */
export interface CheckCounters {
  readonly w: number;
  readonly b: number;
}

/** Internal delivered counts → the remaining counts a FEN carries. */
export function remainingFromDelivered(delivered: CheckCounters): CheckCounters {
  return {
    w: THREE_CHECK_LIMIT - delivered.w,
    b: THREE_CHECK_LIMIT - delivered.b,
  };
}

/** The remaining counts a FEN carries → internal delivered counts. */
export function deliveredFromRemaining(remaining: CheckCounters): CheckCounters {
  return {
    w: THREE_CHECK_LIMIT - remaining.w,
    b: THREE_CHECK_LIMIT - remaining.b,
  };
}

/**
 * The canonical Three-Check FEN field: remaining checks, White first.
 *
 * This is field five, between the en-passant square and the halfmove clock — where
 * Fairy-Stockfish both accepts and emits it.
 */
export function formatRemaining(delivered: CheckCounters): string {
  const remaining = remainingFromDelivered(delivered);
  return `${remaining.w}+${remaining.b}`;
}

/** Canonical remaining form, e.g. `2+3`. */
const REMAINING_PATTERN = /^(\d+)\+(\d+)$/;
/** Compatibility delivered form, e.g. `+1+0`, which Fairy also accepts as a trailing field. */
const DELIVERED_PATTERN = /^\+(\d+)\+(\d+)$/;

/** True when `token` is shaped like the canonical remaining field. */
export function looksLikeRemaining(token: string | undefined): boolean {
  return token !== undefined && REMAINING_PATTERN.test(token);
}

/** True when `token` is shaped like the trailing delivered field. */
export function looksLikeDelivered(token: string | undefined): boolean {
  return token !== undefined && DELIVERED_PATTERN.test(token);
}

/**
 * Read a canonical `N+M` remaining field into internal delivered counts.
 *
 * Out-of-range values throw rather than clamp. A FEN claiming four checks remain describes a
 * position this rule set cannot reach, and silently normalising it would invent a legal-looking
 * game state from a malformed input — the same class of quiet corruption that let a lossy snapshot
 * pass for years.
 */
export function parseRemaining(token: string): CheckCounters {
  const match = REMAINING_PATTERN.exec(token);
  if (match === null) {
    throw new FenError(`Three-Check counters must look like "N+M", got "${token}"`);
  }
  return deliveredFromRemaining(assertInRange(Number(match[1]), Number(match[2]), token, 'remaining'));
}

/** Read a trailing `+N+M` delivered field into internal delivered counts. */
export function parseDelivered(token: string): CheckCounters {
  const match = DELIVERED_PATTERN.exec(token);
  if (match === null) {
    throw new FenError(`Three-Check counters must look like "+N+M", got "${token}"`);
  }
  return assertInRange(Number(match[1]), Number(match[2]), token, 'delivered');
}

function assertInRange(w: number, b: number, token: string, kind: string): CheckCounters {
  for (const value of [w, b]) {
    if (!Number.isInteger(value) || value < 0 || value > THREE_CHECK_LIMIT) {
      throw new FenError(
        `Three-Check ${kind} counters must be between 0 and ${THREE_CHECK_LIMIT}, got "${token}"`,
      );
    }
  }
  return { w, b };
}
