/**
 * @packageDocumentation
 * Castling rights, and the FEN spelling of them.
 *
 * Standard chess can describe castling with four bits, because the rook that carries each right is
 * implied: kingside is always h, queenside is always a. Chess960 breaks that implication — the
 * rooks start on arbitrary files — so a bitmask cannot say *which* rook a right belongs to, and a
 * position with two rooks on the same side of the king becomes unrepresentable.
 *
 * Rights are therefore held as the **file of the rook** that carries each one, `-1` meaning the
 * right is gone. That is one fact stored once: there is no separate "does the right exist" bit that
 * could disagree with the rook it names.
 */

import { fileOf, makePiece, makeSquare, rankOf } from './board';
import type { CastlingRights, CastlingSide, Color, Piece } from './types';

/** A right that is not held. Rook files are 0..7, so `-1` cannot collide with one. */
export const NO_CASTLING_ROOK = -1;

/** Rights with nothing held. */
export function noCastlingRights(): CastlingRights {
  return {
    w: { k: NO_CASTLING_ROOK, q: NO_CASTLING_ROOK },
    b: { k: NO_CASTLING_ROOK, q: NO_CASTLING_ROOK },
  };
}

/** Deep copy; `PositionState` is cloned before every mutation. */
export function cloneCastlingRights(rights: CastlingRights): CastlingRights {
  return { w: { k: rights.w.k, q: rights.w.q }, b: { k: rights.b.k, q: rights.b.q } };
}

/** True when any right at all is held. */
export function hasAnyCastlingRight(rights: CastlingRights): boolean {
  return (
    rights.w.k !== NO_CASTLING_ROOK ||
    rights.w.q !== NO_CASTLING_ROOK ||
    rights.b.k !== NO_CASTLING_ROOK ||
    rights.b.q !== NO_CASTLING_ROOK
  );
}

/** The back rank a colour castles on. */
export function backRankOf(color: Color): number {
  return color === 'w' ? 0 : 7;
}

/** The king's square once it has castled: g-file kingside, c-file queenside. */
export function castledKingSquare(color: Color, side: CastlingSide): number {
  return makeSquare(side === 'k' ? 6 : 2, backRankOf(color));
}

/** The rook's square once it has castled: f-file kingside, d-file queenside. */
export function castledRookSquare(color: Color, side: CastlingSide): number {
  return makeSquare(side === 'k' ? 5 : 3, backRankOf(color));
}

/**
 * Drop any right whose rook stands on `square`, for either colour.
 *
 * This is how a right dies when the rook that carries it moves away or is captured. It is keyed on
 * the rook's actual square rather than on a fixed corner, which is the whole point: in Chess960 the
 * corner is not where the rook is.
 */
export function clearRightsForSquare(rights: CastlingRights, square: number): void {
  const file = fileOf(square);
  const rank = rankOf(square);
  for (const color of ['w', 'b'] as const) {
    if (rank !== backRankOf(color)) continue;
    const held = rights[color];
    if (held.k === file) held.k = NO_CASTLING_ROOK;
    if (held.q === file) held.q = NO_CASTLING_ROOK;
  }
}

/** Drop both of a colour's rights, as a king move does. */
export function clearColorRights(rights: CastlingRights, color: Color): void {
  rights[color].k = NO_CASTLING_ROOK;
  rights[color].q = NO_CASTLING_ROOK;
}

/** Files of every rook of `color` standing on its own back rank, ascending. */
function backRankRookFiles(board: readonly (Piece | null)[], color: Color): number[] {
  const rook = makePiece(color, 'r');
  const rank = backRankOf(color);
  const files: number[] = [];
  for (let file = 0; file < 8; file++) {
    if (board[makeSquare(file, rank)] === rook) files.push(file);
  }
  return files;
}

/** File of `color`'s king if it stands on its own back rank, else `-1`. */
function backRankKingFile(board: readonly (Piece | null)[], color: Color): number {
  const king = makePiece(color, 'k');
  const rank = backRankOf(color);
  for (let file = 0; file < 8; file++) {
    if (board[makeSquare(file, rank)] === king) return file;
  }
  return -1;
}

/**
 * Read a FEN castling field into rights, resolving each right to a specific rook.
 *
 * Two spellings are accepted, because both are in circulation and a reader cannot choose which one
 * arrives:
 *
 * - **Shredder-FEN** names the rook's file directly (`HFhf`), upper case for White. This is what the
 *   published Chess960 perft corpora are written in, so it is not optional.
 * - **X-FEN / standard FEN** keeps `KQkq`, where the right belongs *by definition* to the
 *   **outermost** rook on that side of the king. For standard chess that resolves to h and a, which
 *   is why ordinary FEN keeps working unchanged; for Chess960 it resolves against whatever the
 *   arrangement actually is.
 *
 * The two cannot collide: file letters run a-h, and `k`/`q` are outside that range.
 *
 * A right naming a rook that is not there is dropped rather than kept. The alternative — trusting
 * the field over the board — leaves a right pointing at an empty square, and move generation would
 * have to re-derive the truth anyway.
 *
 * Unrecognised characters are ignored, which is the tolerance this parser has always had.
 */
export function parseCastlingField(
  field: string,
  board: readonly (Piece | null)[],
): CastlingRights {
  const rights = noCastlingRights();
  if (field === '-') return rights;

  for (const ch of field) {
    const color: Color = ch === ch.toUpperCase() ? 'w' : 'b';
    const lower = ch.toLowerCase();
    const kingFile = backRankKingFile(board, color);
    if (kingFile === -1) continue;
    const rookFiles = backRankRookFiles(board, color);

    if (lower === 'k' || lower === 'q') {
      // X-FEN: the outermost rook on that side of the king carries the right.
      const candidates = lower === 'k'
        ? rookFiles.filter((f) => f > kingFile)
        : rookFiles.filter((f) => f < kingFile);
      if (candidates.length === 0) continue;
      const file = lower === 'k'
        ? candidates[candidates.length - 1]
        : candidates[0];
      rights[color][lower] = file;
      continue;
    }

    const file = lower.charCodeAt(0) - 97; // 'a'
    if (file < 0 || file > 7) continue;
    if (!rookFiles.includes(file)) continue;
    // Shredder-FEN: which side the right is depends on where the rook stands relative to the king.
    if (file > kingFile) rights[color].k = file;
    else if (file < kingFile) rights[color].q = file;
  }

  return rights;
}

/**
 * Write rights back as an X-FEN castling field.
 *
 * X-FEN is chosen over Shredder-FEN for the wire form because it is upward compatible: a right held
 * by the outermost rook on its side spells `K`/`Q`, so every standard-chess position — and every
 * Chess960 *starting* position, which has exactly one rook per side of the king — serialises to the
 * ordinary `KQkq` that the rest of the world already reads. A file letter appears only when it
 * carries information `KQkq` cannot: an **inner** rook holds the right while another rook of the
 * same colour stands further out. That can only arise through promotion, and it is precisely the
 * case a bitmask used to lose.
 *
 * Note that this codec does **not** adopt X-FEN's other divergence, its narrower en-passant field.
 * That would change the FEN of every variant, including standard, and it is a separate question
 * from castling.
 */
export function formatCastlingField(
  rights: CastlingRights,
  board: readonly (Piece | null)[],
): string {
  let out = '';
  for (const color of ['w', 'b'] as const) {
    const rookFiles = backRankRookFiles(board, color);
    for (const side of ['k', 'q'] as const) {
      const file = rights[color][side];
      if (file === NO_CASTLING_ROOK) continue;
      const outermost = side === 'k'
        ? !rookFiles.some((f) => f > file)
        : !rookFiles.some((f) => f < file);
      const letter = outermost ? side : String.fromCharCode(97 + file);
      out += color === 'w' ? letter.toUpperCase() : letter;
    }
  }
  return out === '' ? '-' : out;
}
