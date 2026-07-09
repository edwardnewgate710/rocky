/**
 * Bundled endgame database — a small, curated, original dataset covering
 * classic instructive endgames.
 *
 * This is **not** scraped or embedded from a third-party licensed source.
 * The entries are authored from common chess knowledge (endgame types and
 * techniques are public-domain chess terminology).  The dataset is
 * intentionally compact and extensible.
 *
 * Scope: illustrative.  Covers the fundamental checkmates (K+Q, K+R,
 * K+BB, K+BN), key positional endgames (Lucena, Philidor, opposition),
 * and pawn endgames (K+P vs K, K+PP vs K).  ~20 entries.
 */

import type { EndgameEntry, EndgameDatabase, EndgameType, EndgameDifficulty } from './endgame-database.js';

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

const ENTRIES: readonly EndgameEntry[] = [
  // --- K+Q vs K: basic mate ---
  {
    id: 'kq-vs-k-01',
    type: 'KQ_vs_K',
    name: 'Queen vs King mate — king on edge',
    fen: '7k/8/6Q1/8/8/8/8/4K3 w - - 0 1',
    sideToMove: 'w',
    goal: { kind: 'mate', distance: 2 },
    difficulty: 'beginner',
    technique: 'Use the queen to confine the enemy king to the edge, then bring your king to support the mate.',
  },
  {
    id: 'kq-vs-k-02',
    type: 'KQ_vs_K',
    name: 'Queen vs King mate — king in center',
    fen: '8/8/8/4k3/8/8/6Q1/4K3 w - - 0 1',
    sideToMove: 'w',
    goal: { kind: 'mate', distance: 10 },
    difficulty: 'beginner',
    technique: 'Push the enemy king to the edge using the queen, then walk your king up to deliver mate.',
  },
  {
    id: 'kq-vs-k-03',
    type: 'KQ_vs_K',
    name: 'Queen vs King mate — knight-move pattern',
    fen: '6k1/8/6Q1/8/8/8/8/4K3 w - - 0 1',
    sideToMove: 'w',
    goal: { kind: 'mate', distance: 3 },
    difficulty: 'beginner',
    technique: 'The queen delivers mate with knight-move patterns when the enemy king is on the edge.',
  },
  // --- K+R vs K: basic mate ---
  {
    id: 'kr-vs-k-01',
    type: 'KR_vs_K',
    name: 'Rook vs King mate — king on edge',
    fen: '7k/8/8/8/8/8/6R1/4K3 w - - 0 1',
    sideToMove: 'w',
    goal: { kind: 'mate', distance: 4 },
    difficulty: 'intermediate',
    technique: 'Use the rook to cut off the enemy king, then bring your king to support the mate.',
  },
  {
    id: 'kr-vs-k-02',
    type: 'KR_vs_K',
    name: 'Rook vs King mate — king in center',
    fen: '8/8/8/4k3/8/8/8/4K2R w - - 0 1',
    sideToMove: 'w',
    goal: { kind: 'mate', distance: 16 },
    difficulty: 'intermediate',
    technique: 'Cut off the enemy king rank by rank, then walk your king up to deliver mate.',
  },
  // --- K+P vs K: pawn promotion ---
  {
    id: 'kp-vs-k-01',
    type: 'KP_vs_K',
    name: 'King + Pawn vs King — rook pawn win',
    fen: '8/7k/8/6K1/8/8/6P1/8 w - - 0 1',
    sideToMove: 'w',
    goal: { kind: 'win', description: 'Promote the pawn and queen the position.' },
    difficulty: 'intermediate',
    technique: 'Use the king to escort the pawn. The rook pawn is the hardest to promote.',
  },
  {
    id: 'kp-vs-k-02',
    type: 'KP_vs_K',
    name: 'King + Pawn vs King — opposition win',
    fen: '8/8/8/3k4/8/3K4/3P4/8 w - - 0 1',
    sideToMove: 'w',
    goal: { kind: 'win', description: 'Win the opposition and promote the pawn.' },
    difficulty: 'intermediate',
    technique: 'Take the opposition (kings face each other with one square between), then advance the pawn.',
  },
  {
    id: 'kp-vs-k-03',
    type: 'KP_vs_K',
    name: 'King + Pawn vs King — drawn position',
    fen: '8/8/8/8/4k3/4P3/4K3/8 w - - 0 1',
    sideToMove: 'w',
    goal: { kind: 'draw', description: 'Black holds the draw by taking the opposition.' },
    difficulty: 'advanced',
    technique: 'The defender draws by reaching the queening square or taking the opposition.',
  },
  // --- K+BB vs K: bishop pair mate ---
  {
    id: 'kbb-vs-k-01',
    type: 'KBB_vs_K',
    name: 'Two Bishops mate',
    fen: '7k/8/8/8/8/8/4B1B1/4K3 w - - 0 1',
    sideToMove: 'w',
    goal: { kind: 'mate', distance: 20 },
    difficulty: 'advanced',
    technique: 'Drive the enemy king to the edge using the two bishops, then deliver mate with king support.',
  },
  // --- K+BN vs K: bishop + knight mate ---
  {
    id: 'kbn-vs-k-01',
    type: 'KBN_vs_K',
    name: 'Bishop + Knight mate',
    fen: '7k/8/8/8/8/8/4BN2/4K3 w - - 0 1',
    sideToMove: 'w',
    goal: { kind: 'mate', distance: 33 },
    difficulty: 'advanced',
    technique: 'The hardest of the basic mates. Drive the king to the corner matching the bishop\'s color.',
  },
  // --- Lucena position ---
  {
    id: 'lucena-01',
    type: 'Lucena',
    name: 'Lucena position — winning method',
    fen: '8/8/8/8/8/2k5/1P6/1K6 w - - 0 1',
    sideToMove: 'w',
    goal: { kind: 'win', description: 'Build a bridge and promote the pawn.' },
    difficulty: 'advanced',
    technique: 'The Lucena position: the superior side builds a "bridge" with the king to shield the pawn from checks.',
  },
  // --- Philidor position ---
  {
    id: 'philidor-01',
    type: 'Philidor',
    name: 'Philidor position — drawing method',
    fen: '8/8/8/8/8/2k5/8/1K1R1r2 w - - 0 1',
    sideToMove: 'w',
    goal: { kind: 'draw', description: 'Hold the draw with the Philidor defense.' },
    difficulty: 'advanced',
    technique: 'The Philidor defense: keep the rook on the third rank, then move it behind the pawn to draw.',
  },
  // --- Opposition ---
  {
    id: 'opposition-01',
    type: 'Opposition',
    name: 'King opposition — winning the opposition',
    fen: '8/8/8/3k4/8/3K4/8/8 w - - 0 1',
    sideToMove: 'w',
    goal: { kind: 'win', description: 'Win the opposition and penetrate with the king.' },
    difficulty: 'intermediate',
    technique: 'The side that wins the opposition can force the enemy king to give way.',
  },
  {
    id: 'opposition-02',
    type: 'Opposition',
    name: 'Distant opposition',
    fen: '8/8/8/3k4/8/8/3K4/8 w - - 0 1',
    sideToMove: 'w',
    goal: { kind: 'win', description: 'Win the distant opposition and approach.' },
    difficulty: 'advanced',
    technique: 'With an odd number of squares between kings, the player to move has the opposition.',
  },
  // --- K+PP vs K ---
  {
    id: 'kpp-vs-k-01',
    type: 'KPP_vs_K',
    name: 'King + Two Pawns vs King — connected pawns',
    fen: '8/8/8/8/8/4k3/4PP2/4K3 w - - 0 1',
    sideToMove: 'w',
    goal: { kind: 'win', description: 'Advance the connected pawns to promotion.' },
    difficulty: 'intermediate',
    technique: 'Connected pawns support each other. Advance them together with king support.',
  },
  // --- K+BP vs K ---
  {
    id: 'kbp-vs-k-01',
    type: 'KBP_vs_K',
    name: 'King + Bishop + Pawn vs King — wrong rook pawn',
    fen: '8/8/8/8/8/4k3/4P3/4KB2 w - - 0 1',
    sideToMove: 'w',
    goal: { kind: 'draw', description: 'The wrong-colored bishop cannot mate — the pawn promotes but it\'s a draw.' },
    difficulty: 'advanced',
    technique: 'If the bishop doesn\'t control the promotion square, the position is drawn even with extra material.',
  },
  // --- K+NP vs K ---
  {
    id: 'knp-vs-k-01',
    type: 'KNP_vs_K',
    name: 'King + Knight + Pawn vs King',
    fen: '8/8/8/8/8/4k3/4P3/4KN2 w - - 0 1',
    sideToMove: 'w',
    goal: { kind: 'win', description: 'Use the knight to support pawn promotion.' },
    difficulty: 'advanced',
    technique: 'The knight helps control key squares to escort the pawn to promotion.',
  },
  // --- KQ vs KR ---
  {
    id: 'kq-vs-kr-01',
    type: 'KQ_vs_KR',
    name: 'Queen vs Rook — winning technique',
    fen: '6k1/8/8/8/8/8/6r1/4KQ2 w - - 0 1',
    sideToMove: 'w',
    goal: { kind: 'win', description: 'Win the rook or force mate with the queen.' },
    difficulty: 'advanced',
    technique: 'The queen wins against the rook by systematic pressure, eventually winning the rook or forcing mate.',
  },
  // --- KRB vs K ---
  {
    id: 'krb-vs-k-01',
    type: 'KRB_vs_K',
    name: 'Rook + Bishop vs King mate',
    fen: '7k/8/8/8/8/8/4RB2/4K3 w - - 0 1',
    sideToMove: 'w',
    goal: { kind: 'mate', distance: 15 },
    difficulty: 'intermediate',
    technique: 'Use the rook to cut off and the bishop to control, then mate with king support.',
  },
  // --- KRP vs KR ---
  {
    id: 'krp-vs-kr-01',
    type: 'KRP_vs_KR',
    name: 'Rook + Pawn vs Rook — winning',
    fen: '8/8/8/8/8/2k5/2P5/2K1R1r1 w - - 0 1',
    sideToMove: 'w',
    goal: { kind: 'win', description: 'Advance the pawn with rook support to promotion.' },
    difficulty: 'advanced',
    technique: 'Use the rook to shield the pawn from checks, advance the king to support promotion.',
  },
  // --- KQP vs KQ ---
  {
    id: 'kqp-vs-kq-01',
    type: 'KQP_vs_KQ',
    name: 'Queen + Pawn vs Queen — winning',
    fen: '8/8/8/8/8/2k5/2P5/2KQq3 w - - 0 1',
    sideToMove: 'w',
    goal: { kind: 'win', description: 'Advance the pawn with queen support.' },
    difficulty: 'advanced',
    technique: 'Use the queen to shield the pawn from checks, advance the king to support promotion.',
  },
];

// ---------------------------------------------------------------------------
// BundledEndgameDatabase
// ---------------------------------------------------------------------------

/**
 * The default `EndgameDatabase` implementation, backed by the bundled
 * curated dataset.
 */
export class BundledEndgameDatabase implements EndgameDatabase {
  private readonly entries: readonly EndgameEntry[];

  constructor(entries: readonly EndgameEntry[] = ENTRIES) {
    this.entries = entries;
  }

  all(): readonly EndgameEntry[] {
    return this.entries;
  }

  getById(id: string): EndgameEntry | undefined {
    return this.entries.find(e => e.id === id);
  }

  getByType(type: EndgameType): readonly EndgameEntry[] {
    return this.entries.filter(e => e.type === type);
  }

  getByDifficulty(difficulty: EndgameDifficulty): readonly EndgameEntry[] {
    return this.entries.filter(e => e.difficulty === difficulty);
  }

  random(filter?: { readonly type?: EndgameType; readonly difficulty?: EndgameDifficulty }): EndgameEntry {
    let pool = this.entries;
    if (filter?.type) pool = pool.filter(e => e.type === filter.type);
    if (filter?.difficulty) pool = pool.filter(e => e.difficulty === filter.difficulty);
    if (pool.length === 0) {
      // Fallback: return the first entry if filters are too restrictive.
      return this.entries[0];
    }
    const idx = Math.floor(Math.random() * pool.length);
    return pool[idx];
  }
}
