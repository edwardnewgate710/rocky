/**
 * @packageDocumentation
 * Core domain types for the chess engine.
 *
 * The engine uses the 0x88 board representation: a 128-element array where a
 * square index encodes rank and file as `rank * 16 + file`. A square is off the
 * board iff `(index & 0x88) !== 0`. This makes off-board detection a single
 * bitwise AND and makes sliding-piece generation branch-light.
 */

/** Piece colors. */
export type Color = 'w' | 'b';

/** Piece kinds using standard algebraic letters (lowercase). */
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';

/**
 * A piece on the board, encoded as a single character:
 * uppercase = white, lowercase = black. e.g. `'P'` white pawn, `'k'` black king.
 */
export type Piece =
  | 'P' | 'N' | 'B' | 'R' | 'Q' | 'K'
  | 'p' | 'n' | 'b' | 'r' | 'q' | 'k';

/** Supported rule sets. Each variant only overrides what differs from standard. */
export type Variant =
  | 'standard'
  | 'chess960'
  | 'kingofthehill'
  | 'atomic'
  | 'crazyhouse'
  | 'threecheck'
  | 'horde'
  | 'racingkings';

/** Castling rights as an integer bitmask. */
export const enum CastleRight {
  WhiteKing = 1,
  WhiteQueen = 2,
  BlackKing = 4,
  BlackQueen = 8,
}

/** Bit flags describing the nature of a move. */
export const enum MoveFlag {
  Normal = 0,
  Capture = 1 << 0,
  DoublePawnPush = 1 << 1,
  EnPassant = 1 << 2,
  KingCastle = 1 << 3,
  QueenCastle = 1 << 4,
  Promotion = 1 << 5,
}

/**
 * A fully-specified move. `from`/`to` are 0x88 square indices. For Crazyhouse
 * drops, `from` is -1 and `drop` names the piece being placed.
 */
export interface Move {
  readonly from: number;
  readonly to: number;
  readonly piece: Piece;
  readonly captured?: Piece;
  readonly promotion?: PieceType;
  readonly drop?: PieceType;
  readonly flags: number;
}

/**
 * A complete, self-contained game position. Immutable from the caller's
 * perspective — mutation happens only inside {@link Position.applyMove} via an
 * internal clone, so previously-returned positions are never altered.
 */
export interface PositionState {
  /** 0x88 board; each cell is a {@link Piece} or `null`. */
  board: (Piece | null)[];
  turn: Color;
  /** Castling rights bitmask, see {@link CastleRight}. */
  castling: number;
  /** En-passant target square (0x88 index) or -1 if none. */
  epSquare: number;
  /** Halfmove clock for the fifty-move rule. */
  halfmoves: number;
  /** Fullmove counter, starts at 1, increments after Black moves. */
  fullmoves: number;
  /** Crazyhouse pockets: captured pieces available to drop. */
  pockets: { w: PieceType[]; b: PieceType[] };
  /** Three-check: checks delivered by each side. */
  checkCount: { w: number; b: number };
  variant: Variant;
}

/** Result of a legality/termination query. */
export type GameStatus =
  | { over: false }
  | { over: true; reason: 'checkmate'; winner: Color }
  | { over: true; reason: 'stalemate' }
  | { over: true; reason: 'insufficient_material' }
  | { over: true; reason: 'fifty_move' }
  | { over: true; reason: 'threefold' }
  | { over: true; reason: 'variant_win'; winner: Color }
  | { over: true; reason: 'variant_draw' };
