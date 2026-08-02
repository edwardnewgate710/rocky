import { StudyRuleError } from './errors';
import type { PgnGame, PgnMoveNode } from './pgn-model';
import { tagValue } from './pgn-model';
import { resolveSan, type PositionReader } from './move-resolver';
import { DEFAULT_STARTING_FEN } from './model';

/**
 * A node of a chapter's variation tree, before it has ids — the shape an import produces and a
 * repository turns into rows. Ids are deliberately absent: they are the storage layer's to mint,
 * and a domain that invented them would be inviting a client to supply them.
 */
export interface ImportedNode {
  readonly san: string;
  /** The position after this move, so a later append does not have to replay the whole line. */
  readonly fenAfter: string;
  readonly comment?: string;
  readonly nags: readonly number[];
  /** Children. The first is the mainline; the rest are the variations PGN wrote as `(...)`. */
  readonly children: readonly ImportedNode[];
}

/** One chapter's worth of imported content. */
export interface ImportedChapter {
  readonly name: string;
  readonly startingFen: string;
  readonly nodes: readonly ImportedNode[];
}

/** The standard opening position, used when a game carries no `FEN` tag. */
export const START_FEN = DEFAULT_STARTING_FEN;

/**
 * Turns one parsed game into a chapter, resolving every SAN against the running position.
 *
 * A game whose movetext is not playable is **rejected outright**, naming the move. Importing it
 * half-way would leave a chapter that looks complete and silently stops at the first bad move —
 * the reader has no way to tell that from a game that really ended there.
 *
 * Variations are resolved from the position *before* their parent move, because that is what a
 * PGN variation means: an alternative to that move, not a continuation of it. Getting this backwards
 * produces a tree that parses and is wrong, which is the worst kind of wrong.
 */
export function importGame(
  reader: PositionReader,
  game: PgnGame,
  chapterName: string
): ImportedChapter {
  const startingFen = tagValue(game, 'FEN') ?? START_FEN;

  return {
    name: chapterName,
    startingFen,
    nodes: buildLine(reader, game.moves, startingFen),
  };
}

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

function buildLine(
  reader: PositionReader,
  moves: readonly PgnMoveNode[],
  fenBefore: string
): readonly ImportedNode[] {
  if (moves.length === 0) {
    return [];
  }

  const [head, ...rest] = moves;
  if (head === undefined) {
    return [];
  }

  const san = resolve(reader, fenBefore, head.san);
  const fenAfter = play(reader, fenBefore, san);

  // What continues from this move are its CHILDREN. What could have been played instead of it are
  // its SIBLINGS — they share its parent and its starting position, which is why they resolve from
  // `fenBefore` rather than from `fenAfter`.
  //
  // Hanging a variation off the node it replaces is the easy mistake here, and it produces a tree
  // that loads, renders, and is quietly wrong: `1. e4 e5 (1... c5)` would claim c5 is a reply to e5
  // instead of an alternative to it.
  const children = buildLine(reader, rest, fenAfter);
  const siblings = head.variations.flatMap((variation) => buildLine(reader, variation, fenBefore));

  const comment = head.comments.length > 0 ? head.comments.join(' ') : undefined;

  return [
    {
      san,
      fenAfter,
      ...(comment === undefined ? {} : { comment }),
      nags: [...head.nags],
      children,
    },
    ...siblings,
  ];
}

function resolve(reader: PositionReader, fen: string, san: string): string {
  try {
    return resolveSan(reader, fen, san);
  } catch (err) {
    if (err instanceof StudyRuleError) {
      throw err;
    }
    // An engine that throws something else is still telling us the move did not work; surfacing it
    // as `invalid_move` keeps the API's error mapping total.
    throw new StudyRuleError('invalid_move', `Could not resolve '${san}': ${String(err)}`);
  }
}

function play(reader: PositionReader, fen: string, san: string): string {
  try {
    return reader.play(fen, san);
  } catch (err) {
    throw new StudyRuleError('invalid_move', `Could not play '${san}': ${String(err)}`);
  }
}
