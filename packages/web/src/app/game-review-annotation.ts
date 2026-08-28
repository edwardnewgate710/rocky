import type { GameReviewClassification } from '../api/models.js';

export interface GameReviewAnnotation {
  readonly label: 'Brilliant' | 'Great' | 'Best move' | 'Excellent' | 'Good move' | 'Book' | 'Inaccuracy' | 'Mistake' | 'Miss' | 'Blunder' | 'Missed win' | 'Unrated';
  readonly symbol: '!!' | '!' | '★' | '✓' | '📖' | '?!' | '?' | '×' | '??' | '•';
  readonly tone: GameReviewClassification | 'neutral';
}

/**
 * The server owns the post-game policy. The browser only translates its closed classification into
 * a readable label and symbol, so one UI release cannot quietly redefine a brilliant move.
 */
export function gameReviewAnnotation(classification: string): GameReviewAnnotation {
  switch (classification) {
    case 'brilliant': return { label: 'Brilliant', symbol: '!!', tone: 'brilliant' };
    case 'great': return { label: 'Great', symbol: '!', tone: 'great' };
    case 'best': return { label: 'Best move', symbol: '★', tone: 'best' };
    case 'excellent': return { label: 'Excellent', symbol: '✓', tone: 'excellent' };
    case 'good': return { label: 'Good move', symbol: '✓', tone: 'good' };
    case 'book': return { label: 'Book', symbol: '📖', tone: 'book' };
    case 'inaccuracy': return { label: 'Inaccuracy', symbol: '?!', tone: 'inaccuracy' };
    case 'mistake': return { label: 'Mistake', symbol: '?', tone: 'mistake' };
    case 'miss': return { label: 'Miss', symbol: '×', tone: 'miss' };
    case 'blunder': return { label: 'Blunder', symbol: '??', tone: 'blunder' };
    case 'missed_win': return { label: 'Missed win', symbol: '×', tone: 'missed_win' };
    default: return { label: 'Unrated', symbol: '•', tone: 'neutral' };
  }
}
