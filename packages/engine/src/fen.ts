/**
 * FEN validation seam. Engines process untrusted FENs; a malformed or hostile string
 * must never reach a native process. This is a *structural* (defense-in-depth) check
 * at the bridge boundary — the authoritative legality check is `@chess-platform/core`,
 * which the deployable service injects as a {@link FenValidator} at its composition root.
 *
 * The shipped {@link StructuralFenValidator} is a real validator (not a stub): it bounds
 * length, enforces a strict character allowlist, and checks the board/side-to-move shape,
 * while staying tolerant of variant extensions (Crazyhouse pockets `[...]`/`~`,
 * Three-Check counters, etc.) so it never rejects a legal variant position.
 */
import { InvalidFenError } from './errors.js';

export interface FenValidator {
  /** Throws {@link InvalidFenError} if `fen` is not structurally acceptable for `variant`. */
  validate(fen: string, variant: string): void;
}

const MAX_FEN_LENGTH = 200;
// Pieces, rank separators, counts, side, castling, en-passant squares, and the
// variant extension characters `[` `]` `~` (Crazyhouse) and `+` (Three-Check / promoted).
const ALLOWED = /^[pnbrqkPNBRQK1-8/wbKQkqA-Ha-h0-9\-~+[\] ]+$/;

export class StructuralFenValidator implements FenValidator {
  validate(fen: string, _variant: string): void {
    if (typeof fen !== 'string' || fen.length === 0) {
      throw new InvalidFenError('FEN must be a non-empty string.');
    }
    if (fen.length > MAX_FEN_LENGTH) {
      throw new InvalidFenError(`FEN exceeds ${MAX_FEN_LENGTH} characters.`);
    }
    if (fen !== fen.trim()) {
      throw new InvalidFenError('FEN must not have leading or trailing whitespace.');
    }
    if (!ALLOWED.test(fen)) {
      throw new InvalidFenError('FEN contains characters outside the allowed set.');
    }

    const fields = fen.split(' ');
    if (fields.length < 2) {
      throw new InvalidFenError('FEN must contain at least a board and a side-to-move field.');
    }

    const [placementField, side] = fields;
    this.validatePlacement(placementField);

    if (side !== 'w' && side !== 'b') {
      throw new InvalidFenError('Side to move must be "w" or "b".');
    }

    // Remaining fields (castling, en passant, clocks, variant counters) are optional and
    // already constrained by the allowlist; the authoritative validator refines them.
  }

  private validatePlacement(placement: string): void {
    // Strip a trailing Crazyhouse pocket, e.g. "....[PPnn]" or a "/pocket" segment.
    const board = placement.replace(/\[[^\]]*\]$/, '');
    const ranks = board.split('/');
    if (ranks.length < 2 || ranks.length > 12) {
      throw new InvalidFenError('FEN board must have between 2 and 12 ranks.');
    }
    for (const rank of ranks) {
      if (rank.length === 0) {
        throw new InvalidFenError('FEN board contains an empty rank.');
      }
      let squares = 0;
      for (const ch of rank) {
        if (ch >= '1' && ch <= '9') {
          squares += ch.charCodeAt(0) - '0'.charCodeAt(0);
        } else if (/[pnbrqkPNBRQK]/.test(ch)) {
          squares += 1;
        } else if (ch === '~' || ch === '+') {
          // Promotion/marker suffix on the preceding piece — not its own square.
          continue;
        } else {
          throw new InvalidFenError(`Illegal character "${ch}" in board rank.`);
        }
      }
      if (squares < 1 || squares > 16) {
        throw new InvalidFenError('FEN rank describes an implausible number of squares.');
      }
    }
  }
}

/** A shared instance; the validator is stateless and safe to reuse. */
export const structuralFenValidator: FenValidator = new StructuralFenValidator();
