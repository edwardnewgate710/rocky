/**
 * Verbalization logic for the Voice Coach (M8 increment 8).
 *
 * The core engineering idea: **chess notation is not speakable**, and that
 * transformation is pure, deterministic, and exhaustively unit-testable.
 *
 * Raw SAN read literally is gibberish aloud:
 * - `Nxe5` read as "N-x-e-5" is broken; it should be "Knight takes e five."
 * - `O-O` should be "castles kingside."
 * - `e8=Q` should be "e eight, promotes to queen."
 * - `+` should be "check."; `#` should be "checkmate."
 *
 * This module transforms SAN into natural spoken English.  It uses
 * `@chess-platform/core`'s `Position` to convert UCI moves to SAN, then
 * reshapes the SAN into spoken form.  The transform is pure: same input
 * always produces the same output.
 */

import { Position } from '@chess-platform/core';
import type { Move } from '@chess-platform/core';
import type { MoveUci } from './types.js';

// ---------------------------------------------------------------------------
// Piece names
// ---------------------------------------------------------------------------

/** Map of SAN piece letters to spoken names. */
const PIECE_NAMES: Record<string, string> = {
  K: 'King',
  Q: 'Queen',
  R: 'Rook',
  B: 'Bishop',
  N: 'Knight',
};

/** Map of promotion piece letters to spoken names (lowercase). */
const PROMOTION_NAMES: Record<string, string> = {
  q: 'queen',
  r: 'rook',
  b: 'bishop',
  n: 'knight',
};

// ---------------------------------------------------------------------------
// Coordinate speaking
// ---------------------------------------------------------------------------

/**
 * Speak a square coordinate in natural English.
 *
 * `e5` → `"e five"`, `d1` → `"d one"`, `h8` → `"h eight"`.
 * The file letter is spoken as-is; the rank number is spoken as a word.
 */
export function speakSquare(square: string): string {
  const file = square[0]!;
  const rank = square[1]!;
  const rankWord = RANK_WORDS[rank] ?? rank;
  return `${file} ${rankWord}`;
}

/** Map of rank digits to spoken words. */
const RANK_WORDS: Record<string, string> = {
  '1': 'one',
  '2': 'two',
  '3': 'three',
  '4': 'four',
  '5': 'five',
  '6': 'six',
  '7': 'seven',
  '8': 'eight',
};

// ---------------------------------------------------------------------------
// SAN → spoken form
// ---------------------------------------------------------------------------

/**
 * Transform a SAN string into natural spoken English.
 *
 * This is the heart of the Voice Coach — a pure, deterministic function.
 *
 * Examples:
 * - `e4` → `"e four"`
 * - `Nxe5` → `"Knight takes e five"`
 * - `O-O` → `"castles kingside"`
 * - `O-O-O` → `"castles queenside"`
 * - `e8=Q` → `"e eight, promotes to queen"`
 * - `Qd1` → `"Queen to d one"`
 * - `Qd1+` → `"Queen to d one, check"`
 * - `Qd1#` → `"Queen to d one, checkmate"`
 * - `Nbd7` → `"Knight b to d seven"` (disambiguated by file)
 * - `R1e2` → `"Rook one to e two"` (disambiguated by rank)
 * - `exd5` → `"e takes d five"` (pawn capture)
 *
 * @param san - Standard Algebraic Notation string (from `Position.toSan`).
 * @returns Natural spoken English form of the move.
 */
export function verbalizeSan(san: string): string {
  // Strip check/checkmate suffix — we append it at the end.
  let checkSuffix = '';
  let core = san;
  if (core.endsWith('#')) {
    checkSuffix = ', checkmate';
    core = core.slice(0, -1);
  } else if (core.endsWith('+')) {
    checkSuffix = ', check';
    core = core.slice(0, -1);
  }

  // Castling.
  if (core === 'O-O') {
    return `castles kingside${checkSuffix}`;
  }
  if (core === 'O-O-O') {
    return `castles queenside${checkSuffix}`;
  }

  // Promotion: e8=Q, exd8=Q
  const promoMatch = core.match(/^(.*)=([QRBN])$/);
  if (promoMatch) {
    const movePart = promoMatch[1]!;
    const promoPiece = promoMatch[2]!.toLowerCase();
    const spokenMove = verbalizeSanCore(movePart);
    const promoName = PROMOTION_NAMES[promoPiece] ?? promoPiece;
    return `${spokenMove}, promotes to ${promoName}${checkSuffix}`;
  }

  // Standard move (possibly with check/mate already stripped).
  return `${verbalizeSanCore(core)}${checkSuffix}`;
}

/**
 * Transform the core of a SAN string (no check/mate suffix, no promotion)
 * into spoken English.
 */
function verbalizeSanCore(san: string): string {
  // Drop move: N@e4 → "Knight drops to e four"
  const dropMatch = san.match(/^([NBRQK])@([a-h][1-8])$/);
  if (dropMatch) {
    const piece = PIECE_NAMES[dropMatch[1]!] ?? dropMatch[1]!;
    const square = speakSquare(dropMatch[2]!);
    return `${piece} drops to ${square}`;
  }

  // Pawn move: e4, e8 (no piece letter prefix)
  // Pawn capture: exd5 (file + x + square)
  // These start with a lowercase file letter.
  if (/^[a-h]/.test(san)) {
    // Pawn capture: exd5
    const pawnCaptureMatch = san.match(/^([a-h])x([a-h][1-8])$/);
    if (pawnCaptureMatch) {
      const fromFile = pawnCaptureMatch[1]!;
      const toSquare = speakSquare(pawnCaptureMatch[2]!);
      return `${fromFile} takes ${toSquare}`;
    }
    // Pawn push: e4, e8
    const pawnPushMatch = san.match(/^([a-h][1-8])$/);
    if (pawnPushMatch) {
      return speakSquare(pawnPushMatch[1]!);
    }
    // Fallback for unexpected pawn notation.
    return san;
  }

  // Piece move: starts with uppercase piece letter [KQRBN].
  // Format: [Piece][disambiguation][x][square]
  // Examples: Nf3, Nxe5, Nbd7, R1e2, Qh4xe1, Nbd2

  const pieceLetter = san[0]!;
  const pieceName = PIECE_NAMES[pieceLetter] ?? pieceLetter;
  let rest = san.slice(1); // everything after the piece letter

  // Check for capture.
  const captureIndex = rest.indexOf('x');
  let isCapture = false;
  if (captureIndex !== -1) {
    isCapture = true;
    rest = rest.slice(0, captureIndex) + rest.slice(captureIndex + 1);
  }

  // Now `rest` is: [disambiguation][square]
  // The square is always the last 2 characters ([a-h][1-8]).
  const square = rest.slice(-2);
  let disambiguation = rest.slice(0, -2);

  // Build the spoken form.
  let spoken = pieceName;

  // Disambiguation: could be a file (a-h), a rank (1-8), or both (e.g. "e1").
  if (disambiguation) {
    // If it's a single file letter.
    if (/^[a-h]$/.test(disambiguation)) {
      spoken += ` ${disambiguation}`;
    } else if (/^[1-8]$/.test(disambiguation)) {
      // Single rank digit.
      spoken += ` ${RANK_WORDS[disambiguation] ?? disambiguation}`;
    } else {
      // Full square (e.g. "e1") — speak both.
      spoken += ` ${speakSquare(disambiguation)}`;
    }
  }

  // Connection word.
  spoken += isCapture ? ' takes' : ' to';

  // Destination square.
  spoken += ` ${speakSquare(square)}`;

  return spoken;
}

// ---------------------------------------------------------------------------
// UCI → spoken form (via Position.toSan)
// ---------------------------------------------------------------------------

/**
 * Convert a UCI move to spoken English, given the position FEN.
 *
 * Uses `Position.fromFen(fen).toSan(move)` to get standard SAN, then
 * transforms it to the spoken form via `verbalizeSan`.
 *
 * @param fen - FEN of the position in which the move is played.
 * @param uci - UCI move string (e.g. `"e2e4"`, `"e7e8q").
 * @returns Natural spoken English, or the raw UCI if the move cannot be parsed.
 */
export function verbalizeUci(fen: string, uci: MoveUci): string {
  try {
    const position = Position.fromFen(fen);
    // Find the legal move matching this UCI.
    const legalMoves = position.legalMoves();
    const matching = legalMoves.find((m: Move) => position.toUci(m) === uci);
    if (!matching) {
      // Not a legal move — return the UCI as-is (shouldn't happen in practice).
      return uci;
    }
    const san = position.toSan(matching);
    return verbalizeSan(san);
  } catch {
    // If FEN parsing fails, return the raw UCI.
    return uci;
  }
}

// ---------------------------------------------------------------------------
// Assessment speaking
// ---------------------------------------------------------------------------

/**
 * Speak a mistake classification in natural English.
 *
 * @param classification - The mistake classification from `MistakeVerdict`.
 * @returns Natural spoken English assessment.
 */
export function speakClassification(
  classification: 'ok' | 'inaccuracy' | 'mistake' | 'blunder',
): string {
  switch (classification) {
    case 'ok': return 'That move is fine.';
    case 'inaccuracy': return 'That move is a slight inaccuracy.';
    case 'mistake': return 'That move is a mistake.';
    case 'blunder': return 'That move is a blunder.';
  }
}
