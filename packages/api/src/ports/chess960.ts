/**
 * @packageDocumentation
 * The Chess960 starting-position port. Every draw of "which of the 960 arrangements does this new
 * game use" goes through {@link Chess960StartSelector}, so tests can force a known arrangement and
 * production cannot reach for entropy in the middle of a handler.
 *
 * This is a port for the same reason {@link ../ports/clock.Clock} and {@link ../ports/ids.IdGenerator}
 * are: the value is drawn once, written to an append-only log, and never reproducible afterwards, so
 * a test that cannot pin it can only assert that *something* was chosen. `Position.chess960(id)`
 * being deterministic (ADR-0136 §1) is what makes pinning it worth anything — an injected id names an
 * exact board.
 */

import { randomInt } from 'node:crypto';
import { CHESS960_POSITIONS } from '@chess-platform/core';

/** Draws the Scharnagl starting-position id for a new Chess960 game. */
export interface Chess960StartSelector {
  /** A starting-position id in 0..959. */
  next(): number;
}

/**
 * Wrap a raw integer source as a selector, checking every draw is a usable id.
 *
 * The check is the point of the wrapper. A source that returns `960`, `-1` or a float is a bug in
 * whatever supplied it, and the failure worth avoiding is the quiet one: the id ends up on a
 * `GameCreated` event in an append-only store, where "the draw was out of range that day" is not a
 * thing anyone can establish later. Failing at the draw keeps the bad value out of history entirely,
 * and is also what a deterministic test can assert against — {@link fixedChess960Start} exists to
 * force a *valid* id, not to smuggle an invalid one past the guard.
 */
export function chess960StartSelector(draw: () => number): Chess960StartSelector {
  return {
    next(): number {
      const id = draw();
      if (!Number.isInteger(id) || id < 0 || id >= CHESS960_POSITIONS) {
        throw new RangeError(
          `Chess960 starting-position source produced ${JSON.stringify(id)}, which is not an integer ` +
            `in 0..${CHESS960_POSITIONS - 1}.`,
        );
      }
      return id;
    },
  };
}

/**
 * The production selector: a uniform draw from the CSPRNG.
 *
 * `randomInt(max)` rather than `Math.floor(Math.random() * 960)`. Two reasons, and the second is the
 * one that decides it. `Math.random` is not seeded from a cryptographic source, and a start position
 * a player could predict before accepting a seek is a small but real competitive edge in a variant
 * whose whole difficulty is unfamiliarity. And `randomInt` rejects the biased tail of the underlying
 * range rather than taking a modulus, so all 960 arrangements are genuinely equally likely; a modulo
 * draw would quietly favour some of them.
 */
export const cryptoChess960Start: Chess960StartSelector = chess960StartSelector(() =>
  randomInt(CHESS960_POSITIONS),
);

/** A selector that always draws `id`, so a test can name the arrangement it wants to see. */
export function fixedChess960Start(id: number): Chess960StartSelector {
  return chess960StartSelector(() => id);
}
