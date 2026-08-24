import type { MistakeClassification } from '../api/models.js';

export interface GameReviewAnnotation {
  readonly label: 'Best move' | 'Good move' | 'Inaccuracy' | 'Mistake' | 'Blunder';
  readonly symbol: '★' | '✓' | '?!' | '?' | '??';
  readonly tone: 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';
}

/**
 * Translate only evidence the current engine policy actually produces into familiar review marks.
 *
 * A "brilliant" label needs additional tactical and sacrifice analysis that the current fixed
 * two-search assessment does not establish. Calling a move brilliant without that evidence would
 * be a cosmetic claim, so this deliberately stops at best/good and the measured error ladder.
 */
export function gameReviewAnnotation(input: {
  readonly move: string;
  readonly bestMove: string | null;
  readonly classification: MistakeClassification;
}): GameReviewAnnotation {
  switch (input.classification) {
    case 'blunder': return { label: 'Blunder', symbol: '??', tone: 'blunder' };
    case 'mistake': return { label: 'Mistake', symbol: '?', tone: 'mistake' };
    case 'inaccuracy': return { label: 'Inaccuracy', symbol: '?!', tone: 'inaccuracy' };
    case 'ok':
      return input.bestMove === input.move
        ? { label: 'Best move', symbol: '★', tone: 'best' }
        : { label: 'Good move', symbol: '✓', tone: 'good' };
  }
}
