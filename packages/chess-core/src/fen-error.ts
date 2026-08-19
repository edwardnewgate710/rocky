/**
 * @packageDocumentation
 * `FenError` on its own, so the counter conversions and the FEN codec can both throw it.
 *
 * `fen.ts` needs `check-counters.ts` to read the Three-Check field, and `check-counters.ts` needs
 * this error to reject a malformed one. Keeping the error here breaks that cycle rather than
 * duplicating the type or letting the counters throw something less specific.
 */

/** Thrown when a FEN string is malformed. */
export class FenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FenError';
  }
}
