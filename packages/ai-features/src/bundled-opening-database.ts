/**
 * Bundled opening database — a small, curated, original dataset covering
 * common chess openings.
 *
 * This is **not** a scraped or embedded third-party licensed database.
 * The entries are authored from common chess knowledge (ECO codes and
 * opening names are public-domain chess terminology).  The dataset is
 * intentionally compact (a few dozen well-known openings) and
 * extensible — a larger or live adapter can implement the
 * `OpeningDatabase` port later without touching the `OpeningExplorer`
 * feature.
 *
 * Scope: illustrative.  Covers the major openings (Ruy Lopez, Sicilian
 * Najdorf, Queen's Gambit, French, Caro-Kann, Italian, English, etc.)
 * to a depth of 3–6 moves.  Stats are approximate aggregate figures
 * for illustration; they are not sourced from a specific database.
 */

import type { OpeningEntry, OpeningDatabase, OpeningLookupResult } from './opening-database.js';
import type { MoveUci } from './types.js';

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

/**
 * The bundled opening entries.  Each entry's `moves` field is the UCI
 * sequence that defines the line.  Entries are ordered by move count
 * (longest first) so the `lookup` function can find the deepest match.
 */
const ENTRIES: readonly OpeningEntry[] = [
  // --- 1.e4 e5 2.Nf3 Nc6 3.Bb5 — Ruy Lopez (Spanish) ---
  {
    eco: 'C60',
    name: 'Ruy Lopez (Spanish Opening)',
    moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'],
    continuations: [
      { move: 'a7a6', san: 'a6', eco: 'C70', name: 'Ruy Lopez, Morphy Defense', stats: { games: 50000, whiteWins: 0.39, draws: 0.36, blackWins: 0.25 } },
      { move: 'd7d6', san: 'd6', eco: 'C62', name: 'Ruy Lopez, Old Steinitz Defense', stats: { games: 5000, whiteWins: 0.42, draws: 0.32, blackWins: 0.26 } },
      { move: 'g8f6', san: 'Nf6', eco: 'C65', name: 'Ruy Lopez, Berlin Defense', stats: { games: 8000, whiteWins: 0.36, draws: 0.40, blackWins: 0.24 } },
    ],
    stats: { games: 80000, whiteWins: 0.38, draws: 0.37, blackWins: 0.25 },
  },
  // --- Ruy Lopez, Morphy Defense: 3...a6 ---
  {
    eco: 'C70',
    name: 'Ruy Lopez, Morphy Defense',
    moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6'],
    continuations: [
      { move: 'b5a4', san: 'Ba4', eco: 'C78', name: 'Ruy Lopez, Morphy Defense (Closed)', stats: { games: 30000, whiteWins: 0.38, draws: 0.38, blackWins: 0.24 } },
      { move: 'b1c3', san: 'Nc3', eco: 'C71', name: 'Ruy Lopez, Four Knights Variation', stats: { games: 3000, whiteWins: 0.40, draws: 0.35, blackWins: 0.25 } },
    ],
    stats: { games: 50000, whiteWins: 0.39, draws: 0.36, blackWins: 0.25 },
  },
  // --- 1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4 Nf6 5.Nc3 a6 — Sicilian Najdorf ---
  {
    eco: 'B90',
    name: 'Sicilian Defense, Najdorf Variation',
    moves: ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'a7a6'],
    continuations: [
      { move: 'f1e2', san: 'Be2', eco: 'B92', name: 'Sicilian, Najdorf, Be2', stats: { games: 12000, whiteWins: 0.36, draws: 0.35, blackWins: 0.29 } },
      { move: 'f1c4', san: 'Bc4', eco: 'B91', name: 'Sicilian, Najdorf, Bc4', stats: { games: 8000, whiteWins: 0.38, draws: 0.32, blackWins: 0.30 } },
      { move: 'f1b5', san: 'Bb5', eco: 'B94', name: 'Sicilian, Najdorf, Bb5', stats: { games: 10000, whiteWins: 0.37, draws: 0.36, blackWins: 0.27 } },
    ],
    stats: { games: 30000, whiteWins: 0.37, draws: 0.34, blackWins: 0.29 },
  },
  // --- 1.e4 c5 — Sicilian Defense ---
  {
    eco: 'B20',
    name: 'Sicilian Defense',
    moves: ['e2e4', 'c7c5'],
    continuations: [
      { move: 'g1f3', san: 'Nf3', eco: 'B27', name: 'Sicilian, 2.Nf3', stats: { games: 60000, whiteWins: 0.38, draws: 0.30, blackWins: 0.32 } },
      { move: 'b1c3', san: 'Nc3', eco: 'B23', name: 'Sicilian, Closed', stats: { games: 10000, whiteWins: 0.40, draws: 0.32, blackWins: 0.28 } },
    ],
    stats: { games: 80000, whiteWins: 0.38, draws: 0.31, blackWins: 0.31 },
  },
  // --- 1.d4 d5 2.c4 — Queen's Gambit ---
  {
    eco: 'D06',
    name: "Queen's Gambit",
    moves: ['d2d4', 'd7d5', 'c2c4'],
    continuations: [
      { move: 'e7e6', san: 'e6', eco: 'D30', name: "Queen's Gambit Declined", stats: { games: 40000, whiteWins: 0.40, draws: 0.38, blackWins: 0.22 } },
      { move: 'c7c6', san: 'c6', eco: 'D10', name: "Slav Defense", stats: { games: 20000, whiteWins: 0.38, draws: 0.37, blackWins: 0.25 } },
      { move: 'd5c4', san: 'dxc4', eco: 'D20', name: "Queen's Gambit Accepted", stats: { games: 15000, whiteWins: 0.42, draws: 0.33, blackWins: 0.25 } },
    ],
    stats: { games: 80000, whiteWins: 0.40, draws: 0.36, blackWins: 0.24 },
  },
  // --- Queen's Gambit Declined: 1.d4 d5 2.c4 e6 ---
  {
    eco: 'D30',
    name: "Queen's Gambit Declined",
    moves: ['d2d4', 'd7d5', 'c2c4', 'e7e6'],
    continuations: [
      { move: 'b1c3', san: 'Nc3', eco: 'D31', name: 'QGD, Semi-Slav setup', stats: { games: 20000, whiteWins: 0.40, draws: 0.38, blackWins: 0.22 } },
      { move: 'g1f3', san: 'Nf3', eco: 'D40', name: 'QGD, Ragozin Variation', stats: { games: 8000, whiteWins: 0.39, draws: 0.39, blackWins: 0.22 } },
    ],
    stats: { games: 40000, whiteWins: 0.40, draws: 0.38, blackWins: 0.22 },
  },
  // --- 1.e4 e6 — French Defense ---
  {
    eco: 'C00',
    name: 'French Defense',
    moves: ['e2e4', 'e7e6'],
    continuations: [
      { move: 'd2d4', san: 'd4', eco: 'C01', name: 'French, Advance Variation', stats: { games: 20000, whiteWins: 0.42, draws: 0.33, blackWins: 0.25 } },
      { move: 'd2d4', san: 'd4', eco: 'C10', name: 'French, Rubinstein Variation', stats: { games: 10000, whiteWins: 0.40, draws: 0.36, blackWins: 0.24 } },
    ],
    stats: { games: 30000, whiteWins: 0.42, draws: 0.33, blackWins: 0.25 },
  },
  // --- 1.e4 c6 — Caro-Kann Defense ---
  {
    eco: 'B10',
    name: 'Caro-Kann Defense',
    moves: ['e2e4', 'c7c6'],
    continuations: [
      { move: 'd2d4', san: 'd4', eco: 'B12', name: 'Caro-Kann, Main Line', stats: { games: 25000, whiteWins: 0.40, draws: 0.36, blackWins: 0.24 } },
      { move: 'c2c4', san: 'c4', eco: 'B11', name: 'Caro-Kann, Two Knights', stats: { games: 3000, whiteWins: 0.42, draws: 0.34, blackWins: 0.24 } },
    ],
    stats: { games: 30000, whiteWins: 0.40, draws: 0.36, blackWins: 0.24 },
  },
  // --- 1.e4 e5 2.Nf3 Nc6 3.Bc4 — Italian Game ---
  {
    eco: 'C50',
    name: 'Italian Game',
    moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'],
    continuations: [
      { move: 'f8c5', san: 'Bc5', eco: 'C54', name: 'Italian Game, Giuoco Piano', stats: { games: 15000, whiteWins: 0.40, draws: 0.34, blackWins: 0.26 } },
      { move: 'f8e7', san: 'Be7', eco: 'C50', name: 'Italian Game, Hungarian Defense', stats: { games: 2000, whiteWins: 0.42, draws: 0.35, blackWins: 0.23 } },
      { move: 'g8f6', san: 'Nf6', eco: 'C55', name: 'Italian Game, Two Knights Defense', stats: { games: 8000, whiteWins: 0.41, draws: 0.32, blackWins: 0.27 } },
    ],
    stats: { games: 25000, whiteWins: 0.40, draws: 0.34, blackWins: 0.26 },
  },
  // --- 1.c4 — English Opening ---
  {
    eco: 'A10',
    name: 'English Opening',
    moves: ['c2c4'],
    continuations: [
      { move: 'e7e5', san: 'e5', eco: 'A20', name: 'English, Reversed Sicilian', stats: { games: 15000, whiteWins: 0.39, draws: 0.36, blackWins: 0.25 } },
      { move: 'c7c5', san: 'c5', eco: 'A30', name: 'English, Symmetrical', stats: { games: 10000, whiteWins: 0.38, draws: 0.38, blackWins: 0.24 } },
      { move: 'e7e6', san: 'e6', eco: 'A13', name: 'English, Queen\'s Indian setup', stats: { games: 5000, whiteWins: 0.40, draws: 0.37, blackWins: 0.23 } },
    ],
    stats: { games: 30000, whiteWins: 0.39, draws: 0.37, blackWins: 0.24 },
  },
  // --- 1.d4 Nf6 2.c4 e6 3.Nc3 Bb4 — Nimzo-Indian Defense ---
  {
    eco: 'E20',
    name: 'Nimzo-Indian Defense',
    moves: ['d2d4', 'g8f6', 'c2c4', 'e7e6', 'b1c3', 'f8b4'],
    continuations: [
      { move: 'e2e3', san: 'e3', eco: 'E32', name: 'Nimzo-Indian, Rubinstein System', stats: { games: 12000, whiteWins: 0.39, draws: 0.38, blackWins: 0.23 } },
      { move: 'g1f3', san: 'Nf3', eco: 'E21', name: 'Nimzo-Indian, Kasparov Variation', stats: { games: 5000, whiteWins: 0.40, draws: 0.37, blackWins: 0.23 } },
    ],
    stats: { games: 20000, whiteWins: 0.39, draws: 0.38, blackWins: 0.23 },
  },
  // --- 1.d4 Nf6 2.c4 g6 — King's Indian Defense ---
  {
    eco: 'E60',
    name: "King's Indian Defense",
    moves: ['d2d4', 'g8f6', 'c2c4', 'g7g6'],
    continuations: [
      { move: 'b1c3', san: 'Nc3', eco: 'E70', name: 'KID, Main Line', stats: { games: 18000, whiteWins: 0.39, draws: 0.35, blackWins: 0.26 } },
      { move: 'g1f3', san: 'Nf3', eco: 'E62', name: 'KID, Fianchetto Variation', stats: { games: 6000, whiteWins: 0.38, draws: 0.38, blackWins: 0.24 } },
    ],
    stats: { games: 25000, whiteWins: 0.39, draws: 0.36, blackWins: 0.25 },
  },
  // --- 1.e4 e5 2.Nf3 Nc6 3.Nc3 Nf6 — Four Knights Game ---
  {
    eco: 'C45',
    name: 'Four Knights Game',
    moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'b1c3', 'g8f6'],
    continuations: [
      { move: 'f1b5', san: 'Bb5', eco: 'C47', name: 'Four Knights, Spanish Variation', stats: { games: 4000, whiteWins: 0.40, draws: 0.36, blackWins: 0.24 } },
      { move: 'd2d4', san: 'd4', eco: 'C46', name: 'Four Knights, Scotch Variation', stats: { games: 3000, whiteWins: 0.42, draws: 0.33, blackWins: 0.25 } },
    ],
    stats: { games: 8000, whiteWins: 0.41, draws: 0.35, blackWins: 0.24 },
  },
  // --- 1.e4 e5 2.Nf3 Nc6 3.d4 — Scotch Game ---
  {
    eco: 'C44',
    name: 'Scotch Game',
    moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'd2d4'],
    continuations: [
      { move: 'e5d4', san: 'exd4', eco: 'C45', name: 'Scotch Game, Main Line', stats: { games: 8000, whiteWins: 0.42, draws: 0.33, blackWins: 0.25 } },
    ],
    stats: { games: 10000, whiteWins: 0.42, draws: 0.33, blackWins: 0.25 },
  },
  // --- 1.e4 — King's Pawn Game ---
  {
    eco: 'C20',
    name: "King's Pawn Game",
    moves: ['e2e4'],
    continuations: [
      { move: 'e7e5', san: 'e5', eco: 'C40', name: 'Open Game', stats: { games: 100000, whiteWins: 0.39, draws: 0.34, blackWins: 0.27 } },
      { move: 'c7c5', san: 'c5', eco: 'B20', name: 'Sicilian Defense', stats: { games: 80000, whiteWins: 0.38, draws: 0.31, blackWins: 0.31 } },
      { move: 'e7e6', san: 'e6', eco: 'C00', name: 'French Defense', stats: { games: 30000, whiteWins: 0.42, draws: 0.33, blackWins: 0.25 } },
      { move: 'c7c6', san: 'c6', eco: 'B10', name: 'Caro-Kann Defense', stats: { games: 30000, whiteWins: 0.40, draws: 0.36, blackWins: 0.24 } },
    ],
    stats: { games: 250000, whiteWins: 0.40, draws: 0.33, blackWins: 0.27 },
  },
  // --- 1.d4 — Queen's Pawn Game ---
  {
    eco: 'D00',
    name: "Queen's Pawn Game",
    moves: ['d2d4'],
    continuations: [
      { move: 'd7d5', san: 'd5', eco: 'D06', name: 'Closed Game', stats: { games: 120000, whiteWins: 0.40, draws: 0.37, blackWins: 0.23 } },
      { move: 'g8f6', san: 'Nf6', eco: 'E00', name: 'Indian Defense', stats: { games: 80000, whiteWins: 0.39, draws: 0.37, blackWins: 0.24 } },
    ],
    stats: { games: 200000, whiteWins: 0.40, draws: 0.37, blackWins: 0.23 },
  },
];

// ---------------------------------------------------------------------------
// BundledOpeningDatabase
// ---------------------------------------------------------------------------

/**
 * The default `OpeningDatabase` implementation, backed by the bundled
 * curated dataset.
 */
export class BundledOpeningDatabase implements OpeningDatabase {
  private readonly entries: readonly OpeningEntry[];

  constructor(entries: readonly OpeningEntry[] = ENTRIES) {
    // Sort by move count descending so the longest match is found first.
    this.entries = [...entries].sort((a, b) => b.moves.length - a.moves.length);
  }

  lookup(moves: readonly MoveUci[]): OpeningLookupResult {
    if (moves.length === 0) {
      return { kind: 'notFound' };
    }

    // Find the deepest (longest) entry whose move sequence is a prefix
    // of the input.  The entry's moves must be fully covered by the input
    // (entry.moves.length <= input.length).  If the input is longer, the
    // game has gone out of book.
    for (const entry of this.entries) {
      const entryMoves = entry.moves;
      if (entryMoves.length > moves.length) {
        // Entry is longer than input — skip (input hasn't reached this depth).
        continue;
      }
      let matched = true;
      for (let i = 0; i < entryMoves.length; i++) {
        if (entryMoves[i] !== moves[i]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        return {
          kind: 'found',
          entry,
          matchedMoves: entryMoves.length,
          outOfBook: moves.length > entryMoves.length,
        };
      }
    }

    return { kind: 'notFound' };
  }

  /** All entries in the database (for testing/inspection). */
  get allEntries(): readonly OpeningEntry[] {
    return this.entries;
  }
}
