/**
 * The `OpeningDatabase` port and types.
 *
 * An `OpeningDatabase` maps move sequences (UCI) to opening metadata
 * (ECO code, name, main continuations, and optional aggregate stats).
 *
 * The default implementation (`BundledOpeningDatabase`) ships a small,
 * curated, original dataset covering common openings.  A larger or
 * live adapter can implement the same port later without touching the
 * `OpeningExplorer` feature.
 */

import type { MoveUci } from './types.js';

// ---------------------------------------------------------------------------
// Opening entry
// ---------------------------------------------------------------------------

/** A single continuation from the current position in the opening tree. */
export interface OpeningContinuation {
  /** The move in UCI long algebraic notation (e.g. `e2e4`). */
  readonly move: MoveUci;
  /** Optional: SAN representation (e.g. `Nf3`). */
  readonly san?: string;
  /** Optional: ECO code for the resulting position (if known). */
  readonly eco?: string;
  /** Optional: name of the opening after this move (if it changes). */
  readonly name?: string;
  /** Optional: aggregate game stats for this continuation. */
  readonly stats?: OpeningStats;
}

/** Aggregate win/draw/loss stats for a continuation or opening. */
export interface OpeningStats {
  /** Number of games in the dataset for this line. */
  readonly games: number;
  /** Win rate for White (0–1). */
  readonly whiteWins: number;
  /** Draw rate (0–1). */
  readonly draws: number;
  /** Win rate for Black (0–1). */
  readonly blackWins: number;
}

/**
 * A complete opening entry from the database.
 */
export interface OpeningEntry {
  /** ECO classification code (e.g. `C60`, `B90`). */
  readonly eco: string;
  /** Human-readable opening name (e.g. `Ruy Lopez (Spanish)`). */
  readonly name: string;
  /** The move sequence (UCI) that defines this opening line. */
  readonly moves: readonly MoveUci[];
  /** Main continuations from the end of this line. */
  readonly continuations: readonly OpeningContinuation[];
  /** Optional: aggregate stats for this opening. */
  readonly stats?: OpeningStats;
}

// ---------------------------------------------------------------------------
// Lookup result
// ---------------------------------------------------------------------------

/**
 * Result of looking up a move sequence in the opening database.
 *
 * - `found`: the sequence matches a known opening line.  The `entry`
 *   is the deepest (longest) matching entry, and `matchedMoves` is the
 *   number of moves that matched.
 * - `notFound`: no known opening matches the sequence.
 */
export type OpeningLookupResult =
  | {
      readonly kind: 'found';
      readonly entry: OpeningEntry;
      /** How many of the input moves matched the opening line. */
      readonly matchedMoves: number;
      /** Whether the input sequence has diverged from the opening line. */
      readonly outOfBook: boolean;
    }
  | {
      readonly kind: 'notFound';
    };

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * The opening database port.  Given a move sequence (UCI), returns the
 * deepest matching opening entry, or `notFound` if no known opening
 * matches.
 *
 * Implementations:
 * - `BundledOpeningDatabase` — small curated original dataset (default).
 * - Future: live adapter backed by an external API (M14-era).
 * - Tests: `FakeOpeningDatabase` or the bundled one.
 */
export interface OpeningDatabase {
  /**
   * Look up a move sequence in the opening database.
   *
   * @param moves - The move sequence in UCI (e.g. `['e2e4', 'e7e5', 'g1f3']`).
   * @returns The deepest matching opening entry, or `notFound`.
   */
  lookup(moves: readonly MoveUci[]): OpeningLookupResult;
}
