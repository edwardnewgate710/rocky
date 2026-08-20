import type { PgnGame } from './pgn-model';
import { tagValue } from './pgn-model';

/**
 * Names a chapter from the game's tags: the players first, then the event, then its position in
 * the file.
 *
 * Players before event on purpose. `Event` is very often the same string on every game in a file —
 * "Casual Game", "?", a tournament name — so preferring it produces an import where every chapter
 * carries an identical label and the list is useless. The players are the one tag that actually
 * differs game to game.
 *
 * This lives here rather than in each adapter because both adapters import the same PGN and must
 * name it the same way; written out twice it is a difference waiting to appear between what the
 * in-memory tests assert and what the database stores.
 */
export function chapterNameFor(game: PgnGame, index: number): string {
  const white = tagValue(game, 'White');
  const black = tagValue(game, 'Black');
  if (white !== undefined && black !== undefined) {
    return `${white} vs ${black}`;
  }
  return tagValue(game, 'Event') ?? `Chapter ${index + 1}`;
}
