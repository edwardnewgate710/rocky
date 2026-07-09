/**
 * The `EndgameDatabase` port and types.
 *
 * An `EndgameDatabase` provides curated training positions for endgame
 * study.  Each entry identifies a position type (material configuration),
 * a FEN, the side to move, and a learning goal (mate in N / promote /
 * hold the draw).
 *
 * The default implementation (`BundledEndgameDatabase`) ships a small,
 * curated, original dataset covering classic instructive endgames.
 * A larger adapter can implement the same port later.
 */

// ---------------------------------------------------------------------------
// Endgame types
// ---------------------------------------------------------------------------

/** The learning goal for a training endgame. */
export type EndgameGoal =
  | { readonly kind: 'mate'; readonly distance: number }  // mate in N moves
  | { readonly kind: 'win'; readonly description: string }  // win the position
  | { readonly kind: 'draw'; readonly description: string }; // hold the draw

/** Difficulty levels for training positions. */
export type EndgameDifficulty = 'beginner' | 'intermediate' | 'advanced';

/** The material configuration that identifies the endgame type. */
export type EndgameType =
  | 'KQ_vs_K'      // King + Queen vs King
  | 'KR_vs_K'      // King + Rook vs King
  | 'KP_vs_K'      // King + Pawn vs King
  | 'KBB_vs_K'     // King + Two Bishops vs King
  | 'KBN_vs_K'     // King + Bishop + Knight vs King
  | 'KNN_vs_K'     // King + Two Knights vs King (draw)
  | 'KRB_vs_K'     // King + Rook + Bishop vs King
  | 'KQ_vs_KR'     // King + Queen vs King + Rook
  | 'Lucena'      // Lucena position (KP vs KR, winning)
  | 'Philidor'    // Philidor position (KR vs KR+P, drawing)
  | 'Opposition'  // King opposition technique
  | 'KRP_vs_KR'   // King + Rook + Pawn vs King + Rook
  | 'KQP_vs_KQ'   // King + Queen + Pawn vs King + Queen
  | 'KPP_vs_K'    // King + Two Pawns vs King
  | 'KBP_vs_K'    // King + Bishop + Pawn vs King
  | 'KNP_vs_K';   // King + Knight + Pawn vs King

/**
 * A single training endgame entry from the database.
 */
export interface EndgameEntry {
  /** Unique identifier within the dataset. */
  readonly id: string;
  /** The endgame type (material configuration). */
  readonly type: EndgameType;
  /** Human-readable name (e.g. "Queen vs King mate"). */
  readonly name: string;
  /** FEN of the training position. */
  readonly fen: string;
  /** The side to move: 'w' or 'b'. */
  readonly sideToMove: 'w' | 'b';
  /** The learning goal. */
  readonly goal: EndgameGoal;
  /** Difficulty level. */
  readonly difficulty: EndgameDifficulty;
  /** Optional: brief description of the technique to learn. */
  readonly technique?: string;
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * The endgame database port.  Provides curated training positions for
 * endgame study.
 *
 * Implementations:
 * - `BundledEndgameDatabase` — small curated original dataset (default).
 * - Future: larger adapter backed by an external source.
 * - Tests: `FakeEndgameDatabase` or the bundled one.
 */
export interface EndgameDatabase {
  /**
   * Get all training positions in the database.
   */
  all(): readonly EndgameEntry[];

  /**
   * Get a training position by its id.
   */
  getById(id: string): EndgameEntry | undefined;

  /**
   * Get training positions by type.
   */
  getByType(type: EndgameType): readonly EndgameEntry[];

  /**
   * Get training positions by difficulty.
   */
  getByDifficulty(difficulty: EndgameDifficulty): readonly EndgameEntry[];

  /**
   * Get a random training position, optionally filtered by type or difficulty.
   */
  random(filter?: { readonly type?: EndgameType; readonly difficulty?: EndgameDifficulty }): EndgameEntry;
}
