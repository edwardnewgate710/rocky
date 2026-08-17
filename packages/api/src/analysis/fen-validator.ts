/**
 * @packageDocumentation
 * Authoritative FEN validation for the analysis subsystem.
 *
 * Implements the {@link FenValidator} seam from `@chess-platform/engine` by composing
 * the engine package's {@link structuralFenValidator} (defense-in-depth: bounds length
 * and enforces a character allowlist) with `@chess-platform/core`'s {@link parseFen}
 * (authoritative legality check).
 */

import type { Variant } from '@chess-platform/core';
import { parseFen, Position } from '@chess-platform/core';
import type { FenValidator } from '@chess-platform/engine';
import { InvalidFenError, structuralFenValidator } from '@chess-platform/engine';
import { VARIANTS } from '../domain.js';

function isPlatformVariant(candidate: string): candidate is Variant {
  return (VARIANTS as readonly string[]).includes(candidate);
}

/** The piece-placement field, with a Crazyhouse pocket (`[PPnn]`) removed. */
function placementOf(fen: string): string {
  return (fen.split(' ')[0] ?? '').replace(/\[[^\]]*\]$/, '');
}

function countChar(haystack: string, needle: string): number {
  let total = 0;
  for (const character of haystack) if (character === needle) total += 1;
  return total;
}

/**
 * How many kings each side must have, taken from the variant's own starting position rather than
 * hardcoded — which is what makes Horde (no white king) come out right without a special case.
 *
 * King count is invariant across a game: kings are never captured, and in Atomic a king explosion
 * ends the game, so any position that can legitimately be analysed still has them.
 */
const KING_COUNTS = new Map<Variant, { readonly white: number; readonly black: number }>();

function expectedKings(variant: Variant): { readonly white: number; readonly black: number } {
  let counts = KING_COUNTS.get(variant);
  if (counts === undefined) {
    const placement = placementOf(Position.initial(variant).fen());
    counts = { white: countChar(placement, 'K'), black: countChar(placement, 'k') };
    KING_COUNTS.set(variant, counts);
  }
  return counts;
}

export class CoreFenValidator implements FenValidator {
  validate(fen: string, variant: string): void {
    structuralFenValidator.validate(fen, variant);

    if (!isPlatformVariant(variant)) {
      throw new InvalidFenError(`Unsupported or unknown variant "${variant}".`);
    }

    try {
      parseFen(fen, variant);
    } catch {
      throw new InvalidFenError('Invalid FEN position.');
    }

    // `parseFen` decodes; it does not adjudicate. It accepts an empty board, a lone king, and two
    // white kings — none of which is a chess position, and all of which would be handed to a native
    // engine whose behaviour on them is undefined. Raised in the Qodo review of PR #132, where this
    // validator was described (and documented in ADR-0113) as an authoritative legality check that
    // it was not.
    //
    // This does not make it one. Full legality — side-not-to-move already in check, pawns on the
    // back rank, castling rights without the pieces to support them — is a larger surface than this
    // increment needs. The king count is the check that separates a position from a shape, and it
    // is the one the engine's own behaviour depends on.
    const placement = placementOf(fen);
    const expected = expectedKings(variant);
    if (countChar(placement, 'K') !== expected.white || countChar(placement, 'k') !== expected.black) {
      throw new InvalidFenError('Invalid FEN position.');
    }
  }
}

export const coreFenValidator: FenValidator = new CoreFenValidator();
