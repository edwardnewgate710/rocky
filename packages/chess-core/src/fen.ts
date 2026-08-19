/**
 * @packageDocumentation
 * FEN (Forsyth–Edwards Notation) parsing and serialization.
 *
 * Standard FEN plus a Crazyhouse extension: pocket pieces are appended to the
 * piece-placement field in brackets, e.g. `rnbqkbnr/...[NPp] w ...`.
 */

import { CastleRight, type Piece, type PieceType, type PositionState, type Variant } from './types';
import { emptyBoard, makeSquare, squareFromName, squareName, rankOf } from './board';

/** The standard starting position FEN. */
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

import { FenError } from './fen-error';
import {
  formatRemaining,
  looksLikeDelivered,
  looksLikeRemaining,
  parseDelivered,
  parseRemaining,
} from './check-counters';

export { FenError } from './fen-error';

const PIECE_CHARS = new Set(['p', 'n', 'b', 'r', 'q', 'k', 'P', 'N', 'B', 'R', 'Q', 'K']);



/**
 * Parse a FEN string into a {@link PositionState}.
 * @param fen The FEN string.
 * @param variant The rule set this position belongs to.
 */
export function parseFen(fen: string, variant: Variant = 'standard'): PositionState {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) {
    throw new FenError(`FEN must have at least 4 fields, got ${parts.length}: "${fen}"`);
  }
  const [placementRaw, turnRaw, castlingRaw, epRaw] = parts;

  // Three-Check carries a counter field that shifts where the clocks sit, so the clocks cannot
  // be read by fixed index until the layout is known.
  const layout = readCheckLayout(parts, variant);
  const halfmoves = readClock(layout.halfmoveToken, 0);
  const fullmoves = readClock(layout.fullmoveToken, 1);

  const pockets: { w: PieceType[]; b: PieceType[] } = { w: [], b: [] };
  let placement = placementRaw;
  const bracket = placement.indexOf('[');
  if (bracket !== -1) {
    const pocketStr = placement.slice(bracket + 1, placement.indexOf(']'));
    for (const ch of pocketStr) {
      if (ch === ch.toUpperCase()) pockets.w.push(ch.toLowerCase() as PieceType);
      else pockets.b.push(ch as PieceType);
    }
    placement = placement.slice(0, bracket);
  }

  const board = emptyBoard();
  const rows = placement.split('/');
  if (rows.length !== 8) {
    throw new FenError(`FEN placement must have 8 ranks, got ${rows.length}`);
  }
  for (let r = 0; r < 8; r++) {
    const row = rows[r];
    const rank = 7 - r; // FEN lists rank 8 first
    let file = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch);
      } else if (PIECE_CHARS.has(ch)) {
        if (file > 7) throw new FenError(`Rank ${rank + 1} overflows in FEN`);
        board[makeSquare(file, rank)] = ch as Piece;
        file++;
      } else {
        throw new FenError(`Illegal character '${ch}' in FEN placement`);
      }
    }
    if (file !== 8) throw new FenError(`Rank ${rank + 1} does not fill 8 files`);
  }

  if (turnRaw !== 'w' && turnRaw !== 'b') {
    throw new FenError(`Side to move must be 'w' or 'b', got '${turnRaw}'`);
  }

  let castling = 0;
  if (castlingRaw !== '-') {
    for (const ch of castlingRaw) {
      switch (ch) {
        case 'K': castling |= CastleRight.WhiteKing; break;
        case 'Q': castling |= CastleRight.WhiteQueen; break;
        case 'k': castling |= CastleRight.BlackKing; break;
        case 'q': castling |= CastleRight.BlackQueen; break;
        // Chess960 uses file letters (A-H/a-h); handled by the 960 module.
        default: break;
      }
    }
  }

  const epSquare = epRaw === '-' ? -1 : squareFromName(epRaw);

  return {
    board,
    turn: turnRaw,
    castling,
    epSquare,
    halfmoves: Number.isFinite(halfmoves) ? halfmoves : 0,
    fullmoves: Number.isFinite(fullmoves) && fullmoves > 0 ? fullmoves : 1,
    pockets,
    checkCount: { w: layout.delivered.w, b: layout.delivered.b },
    variant,
  };
}

/** Serialize a {@link PositionState} back to a FEN string. */
export function toFen(state: PositionState): string {
  let placement = '';
  for (let r = 7; r >= 0; r--) {
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const piece = state.board[makeSquare(f, r)];
      if (piece === null) {
        empty++;
      } else {
        if (empty > 0) { placement += String(empty); empty = 0; }
        placement += piece;
      }
    }
    if (empty > 0) placement += String(empty);
    if (r > 0) placement += '/';
  }

  if (state.variant === 'crazyhouse') {
    const pocket =
      state.pockets.w.map((p: PieceType) => p.toUpperCase()).join('') +
      state.pockets.b.join('');
    placement += `[${pocket}]`;
  }

  let castling = '';
  if (state.castling & CastleRight.WhiteKing) castling += 'K';
  if (state.castling & CastleRight.WhiteQueen) castling += 'Q';
  if (state.castling & CastleRight.BlackKing) castling += 'k';
  if (state.castling & CastleRight.BlackQueen) castling += 'q';
  if (castling === '') castling = '-';

  const ep = state.epSquare === -1 ? '-' : squareName(state.epSquare);

  // Three-Check gets the counter field Fairy-Stockfish emits: remaining checks, White first,
  // in field five. Every other variant keeps the standard six fields exactly. See ADR-0120.
  const checks = state.variant === 'threecheck' ? `${formatRemaining(state.checkCount)} ` : '';
  return `${placement} ${state.turn} ${castling} ${ep} ${checks}${state.halfmoves} ${state.fullmoves}`;
}

/** The six standard FEN fields, and the seven a canonical Three-Check FEN carries. */
const STANDARD_FIELDS = 6;
const CANONICAL_FIELDS = 7;

/**
 * A move clock, refusing a value that cannot survive the trip back out.
 *
 * `Number('9007199254740993')` is `9007199254740992`. Past `Number.MAX_SAFE_INTEGER` the value
 * changes as it is read, so the FEN this codec emits would describe a different position from the
 * one it was handed — and a codec whose whole purpose is a lossless round trip cannot quietly do
 * that.
 *
 * The bound is deliberately only that. A token that is not a number at all keeps the tolerance it
 * has always had and falls back to the default, because that is long-standing behaviour for every
 * variant and is not what silently rewrites a position.
 *
 * This applies to all variants, not just Three-Check: the defect is older than the counters and
 * lives in the clock reader rather than in anything variant-specific. Raised in the Qodo review of
 * PR #140.
 */
function readClock(token: string | undefined, fallback: number): number {
  if (token === undefined) return fallback;
  const value = Number(token);
  if (!Number.isFinite(value)) return fallback;
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new FenError(`FEN move clock "${token}" is too large to represent exactly`);
  }
  return value;
}

/**
 * Refuse a Three-Check layout whose clock fields are not clocks.
 *
 * `Number('+1+0')` is `NaN`, and the clock readers fall back to a default on `NaN` — so a FEN
 * carrying *both* a canonical counter and a trailing one (`... 2+3 17 +1+0`) parsed happily, threw
 * the second counter away and quietly reset the fullmove to 1. Two counter fields is a contradiction
 * rather than a spelling, and it has to be refused where the discard would otherwise be invisible.
 * Raised in the Qodo review of PR #140.
 *
 * A truncated FEN that never announced the canonical layout keeps its tolerance: `parseFen` has
 * always defaulted absent trailing clocks for every variant, and a five-field `threecheck` FEN with
 * no counter still behaves exactly like a five-field standard one. What is refused is a FEN that
 * declares the seven-field layout by putting a counter in field five and then stops short of it.
 */
function withNumericClocks(layout: CheckLayout): CheckLayout {
  for (const token of [layout.halfmoveToken, layout.fullmoveToken]) {
    if (token !== undefined && !/^\d+$/.test(token)) {
      throw new FenError(`Three-Check FEN has "${token}" where a move clock belongs`);
    }
  }
  return layout;
}

interface CheckLayout {
  readonly delivered: { readonly w: number; readonly b: number };
  readonly halfmoveToken: string | undefined;
  readonly fullmoveToken: string | undefined;
}

/**
 * Work out which Three-Check FEN layout this is, and therefore where the clocks are.
 *
 * Three shapes are accepted, and only for `threecheck` — every other variant reads its clocks
 * from the fixed positions it always has:
 *
 * - canonical, what this codec emits and what Fairy-Stockfish emits:
 *   `<board> <turn> <castling> <ep> N+M <halfmove> <fullmove>`, counters **remaining**;
 * - trailing compatibility, which Fairy also accepts:
 *   `<board> <turn> <castling> <ep> <halfmove> <fullmove> +N+M`, counters **delivered**;
 * - legacy six fields, which every game stored before ADR-0120 uses: no counters, meaning none
 *   have been delivered.
 *
 * A malformed counter field throws instead of falling through to the legacy reading. Treating
 * `2+` or `4+3` as "no counters" would put the clocks back one position and silently rewrite the
 * fifty-move state, which is exactly the corruption this function exists to prevent.
 */
function readCheckLayout(parts: readonly string[], variant: Variant): CheckLayout {
  const none = { w: 0, b: 0 };
  if (variant !== 'threecheck') {
    // A FEN carrying Three-Check counters, read under a rule set that has none, is a mistake
    // somewhere upstream — and reading it anyway is the worst available answer, because the counter
    // sits where the halfmove clock belongs. `... 2+3 17 42` parsed as standard gave halfmove 0 and
    // fullmove 17: both clocks wrong, the counters gone, and nothing said so.
    //
    // This is reachable now in a way it was not before: this codec emits seven-field Three-Check
    // FENs, so any caller that drops the accompanying variant would otherwise corrupt the clocks.
    // Refusing it turns silent corruption into an error at that boundary. Raised in the CodeRabbit
    // review of PR #140.
    if (looksLikeRemaining(parts[4]) || looksLikeDelivered(parts[parts.length - 1])) {
      throw new FenError(
        `FEN carries Three-Check counters but was parsed as "${variant}"; pass the variant`,
      );
    }
    return { delivered: none, halfmoveToken: parts[4], fullmoveToken: parts[5] };
  }

  if (looksLikeRemaining(parts[4])) {
    // A counter in field five declares the canonical layout, and the canonical layout is exactly
    // seven fields: the counter plus both clocks. Accepting a shorter one let `... 2+3 17` through
    // with an invented fullmove — not the parser's ordinary tolerance for a truncated *standard*
    // FEN, because that tolerance is about trailing fields being absent from a six-field layout,
    // not about a FEN that has already announced a longer one. Raised in the Qodo review of PR #140.
    if (parts.length !== CANONICAL_FIELDS) {
      throw new FenError(
        `Canonical Three-Check FEN has ${parts.length} fields, expected exactly ${CANONICAL_FIELDS}`,
      );
    }
    return withNumericClocks({
      delivered: parseRemaining(parts[4]!),
      halfmoveToken: parts[5],
      fullmoveToken: parts[6],
    });
  }

  if (parts.length === CANONICAL_FIELDS && looksLikeDelivered(parts[6])) {
    return withNumericClocks({
      delivered: parseDelivered(parts[6]!),
      halfmoveToken: parts[4],
      fullmoveToken: parts[5],
    });
  }

  // Neither spelling matched, so anything past the six standard fields is unaccounted for.
  // Falling through to the legacy reading here is what an earlier version did, and it silently
  // dropped `+2+`, `+2`, and a stray field after an otherwise valid counter — reserialising a
  // position two checks in as a fresh one and handing the engine a different game. Raised in the
  // Qodo and CodeRabbit reviews of PR #140.
  if (parts.length > STANDARD_FIELDS) {
    throw new FenError(
      `Unrecognised Three-Check counter field "${parts[parts.length - 1]}" ` +
        `in a ${parts.length}-field FEN`,
    );
  }
  if (parts[4] !== undefined && parts[4].includes('+')) {
    throw new FenError(`Malformed Three-Check counter field "${parts[4]}"`);
  }
  return { delivered: none, halfmoveToken: parts[4], fullmoveToken: parts[5] };
}

/** Deep-clone a position state (used before mutation to preserve immutability). */
export function cloneState(state: PositionState): PositionState {
  return {
    board: state.board.slice(),
    turn: state.turn,
    castling: state.castling,
    epSquare: state.epSquare,
    halfmoves: state.halfmoves,
    fullmoves: state.fullmoves,
    pockets: { w: state.pockets.w.slice(), b: state.pockets.b.slice() },
    checkCount: { w: state.checkCount.w, b: state.checkCount.b },
    variant: state.variant,
  };
}

/** True if the FEN's rank layout is otherwise valid but we only need side info. */
export function fenRankOf(sq: number): number {
  return rankOf(sq);
}
