/**
 * `PuzzleGenerator` — M8 increment 2.
 *
 * Given a position (FEN), determines whether it contains a **sharp
 * tactical puzzle** and, if so, produces a structured puzzle.
 *
 * The core engineering idea: a good tactical puzzle is a position with
 * **one clearly best move** that is decisively better than every
 * alternative.  The generator runs the engine with `multiPv: N`; a
 * position qualifies when the best line's eval exceeds the second-best
 * by at least `sharpnessThreshold` centipawns (or the best line is mate
 * and the second-best is not).  This makes puzzle *validity* an
 * objective, testable engine fact — the LLM never decides whether a
 * puzzle is real.
 *
 * The AI provider's role is **only** the human-facing flavour: an
 * optional natural-language puzzle prompt/theme/hint.  It is generated
 * from the engine facts via the M7 grounding path and is clearly
 * separated from the verified solution.  If no AI provider is supplied,
 * the generator still returns a fully valid puzzle with the engine
 * fields — the LLM text is additive, never load-bearing.
 *
 * This follows the exact architectural pattern established by
 * `MoveExplainer` (M8 increment 1): ports injected, engine-verified
 * structured fields, hermetic tests with fakes.
 */

import type { AnalysisProvider, AnalysisRequest, EngineResult, AnalysisLimits, Evaluation } from '@chess-platform/engine';
import type { AiProvider, CompletionRequest, EngineGrounding } from '@chess-platform/ai-orchestrator';
import { engineResultsToGrounding, evalToString, buildGroundedMessages } from '@chess-platform/ai-orchestrator';

import type { GeneratePuzzleRequest, PuzzleResult, Puzzle, PuzzleRejection, PuzzleDifficulty } from './puzzle-types.js';

/** Options for constructing a `PuzzleGenerator`. */
export interface PuzzleGeneratorOptions {
  /** The chess engine analysis provider (M5 port). Injected — never a real binary in tests. */
  readonly engine: AnalysisProvider;
  /** The AI completion provider (M7 port). Optional — the LLM text is additive, never load-bearing. */
  readonly ai?: AiProvider;
  /** Default variant (defaults to `chess`). */
  readonly defaultVariant?: string;
  /** Default analysis limits (used when the request doesn't supply them and no pre-computed analysis is given). */
  readonly defaultLimits?: AnalysisLimits;
  /** Default multi-PV count (defaults to 3). */
  readonly defaultMultiPv?: number;
  /** Default sharpness threshold in centipawns (defaults to 200 = 2.00 pawns). */
  readonly defaultSharpnessThreshold?: number;
  /** Default temperature for the LLM call (defaults to 0.5 for creative puzzle themes). */
  readonly temperature?: number;
  /** Default max output tokens (defaults to 256). */
  readonly maxTokens?: number;
}

/** Default sharpness threshold: 200 cp = 2.00 pawns. */
export const DEFAULT_SHARPNESS_THRESHOLD = 200;

/** Default multi-PV count. */
export const DEFAULT_MULTI_PV = 3;

/**
 * Generates engine-verified tactical puzzles.
 *
 * The puzzle's correctness fields (solution move, eval gap, best line)
 * come entirely from the engine.  The LLM only provides optional
 * human-facing flavour (theme/hint).
 */
export class PuzzleGenerator {
  private readonly engine: AnalysisProvider;
  private readonly ai: AiProvider | undefined;
  private readonly defaultVariant: string;
  private readonly defaultLimits: AnalysisLimits;
  private readonly defaultMultiPv: number;
  private readonly defaultSharpnessThreshold: number;
  private readonly temperature: number;
  private readonly maxTokens: number;

  constructor(options: PuzzleGeneratorOptions) {
    this.engine = options.engine;
    this.ai = options.ai;
    this.defaultVariant = options.defaultVariant ?? 'chess';
    this.defaultLimits = options.defaultLimits ?? { depth: 20 };
    this.defaultMultiPv = options.defaultMultiPv ?? DEFAULT_MULTI_PV;
    this.defaultSharpnessThreshold = options.defaultSharpnessThreshold ?? DEFAULT_SHARPNESS_THRESHOLD;
    this.temperature = options.temperature ?? 0.5;
    this.maxTokens = options.maxTokens ?? 256;
  }

  /**
   * Generate a puzzle from a position.
   *
   * @param request - The position and optional configuration.
   * @returns A `PuzzleResult`: either a verified `Puzzle` or a `PuzzleRejection`.
   */
  async generate(request: GeneratePuzzleRequest): Promise<PuzzleResult> {
    const variant = request.variant ?? this.defaultVariant;
    const limits = request.limits ?? this.defaultLimits;
    const multiPv = request.multiPv ?? this.defaultMultiPv;
    const threshold = request.sharpnessThreshold ?? this.defaultSharpnessThreshold;

    // 1. Obtain engine analysis (multi-PV).
    let results: readonly EngineResult[];
    if (request.analysis && request.analysis.length > 0) {
      results = request.analysis;
    } else {
      const analysisRequest: AnalysisRequest = {
        fen: request.fen,
        variant,
        limits,
        multiPv,
        signal: request.signal,
      };
      results = await this.engine.analyze(analysisRequest);
    }

    // 2. Need at least 2 lines to compute a gap.
    if (results.length < 2) {
      return {
        kind: 'rejection',
        fen: request.fen,
        evalGapCp: 0,
        threshold,
        reason: 'Engine returned fewer than 2 lines; cannot compute eval gap.',
        bestMove: results[0]?.principalVariation[0] ?? '(none)',
        bestEval: results[0]?.evaluation ?? { type: 'cp', value: 0 },
        secondBestEval: { type: 'cp', value: 0 },
        depth: results[0]?.depth ?? 0,
      };
    }

    const best = results[0];
    const second = results[1];

    // 3. Compute the eval gap.
    const gap = evalGapCp(best.evaluation, second.evaluation);

    // 4. Determine if the position qualifies as a puzzle.
    const qualifies = gap >= threshold;

    if (!qualifies) {
      const rejection: PuzzleRejection = {
        kind: 'rejection',
        fen: request.fen,
        evalGapCp: gap,
        threshold,
        reason: `Eval gap (${formatCp(gap)}) is below threshold (${formatCp(threshold)}).`,
        bestMove: best.principalVariation[0] ?? '(none)',
        bestEval: best.evaluation,
        secondBestEval: second.evaluation,
        depth: best.depth,
      };
      return rejection;
    }

    // 5. Derive difficulty from the gap and depth.
    const difficulty = deriveDifficulty(gap, best.depth);

    // 6. Optionally generate LLM theme/hint.
    let theme: string | null = null;
    let hint: string | null = null;
    let providerId: string | null = null;
    let model: string | null = null;
    let usage: import('@chess-platform/ai-orchestrator').TokenUsage | null = null;
    let latencyMs: number | null = null;

    if (this.ai) {
      const grounding: EngineGrounding = engineResultsToGrounding(
        request.fen,
        results,
        best.principalVariation[0],
      );

      const userContent = `Generate a short puzzle prompt for this chess position. ` +
        `The position has a sharp tactical solution. ` +
        `Provide a theme (e.g. "Fork", "Pin", "Skewer", "Mate in N") and a brief hint ` +
        `that guides the solver without revealing the exact move. ` +
        `Format: THEME: <theme>\\nHINT: <hint>`;

      const messages = buildGroundedMessages(
        [{ role: 'user', content: userContent }],
        grounding,
      );

      const completionRequest: CompletionRequest = {
        task: 'puzzle_generation',
        messages,
        temperature: this.temperature,
        maxTokens: this.maxTokens,
        signal: request.signal,
        grounding,
      };

      const response = await this.ai.complete(completionRequest);

      // Parse the LLM response for THEME and HINT lines.
      const parsed = parseThemeHint(response.content);
      theme = parsed.theme;
      hint = parsed.hint;
      providerId = response.providerId;
      model = response.model;
      usage = response.usage;
      latencyMs = response.latencyMs;
    }

    // 7. Build the structured puzzle.
    const puzzle: Puzzle = {
      kind: 'puzzle',
      fen: request.fen,
      solutionMove: best.principalVariation[0] ?? '(none)',
      bestEval: best.evaluation,
      bestEvalLabel: evalToString(best.evaluation),
      secondBestEval: second.evaluation,
      secondBestEvalLabel: evalToString(second.evaluation),
      evalGapCp: gap,
      solutionLine: best.principalVariation,
      depth: best.depth,
      difficulty,
      theme,
      hint,
      providerId,
      model,
      usage,
      latencyMs,
    };

    return puzzle;
  }
}

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

/**
 * Compute the eval gap in centipawns between the best and second-best
 * lines.  If the best line is mate and the second-best is not, the gap
 * is `Infinity` (any threshold is satisfied).  If both are mate, the
 * gap is the difference in mate distance (closer mate = better).
 */
export function evalGapCp(best: Evaluation, second: Evaluation): number {
  // Mate vs non-mate: infinite gap.
  if (best.type === 'mate' && second.type !== 'mate') {
    return Infinity;
  }
  // Both mate: closer mate is better.  Positive value = best is closer.
  if (best.type === 'mate' && second.type === 'mate') {
    // A positive mate value means side-to-move mates; negative means gets mated.
    // Closer to zero = faster mate.  We want the gap to be positive when
    // best is a faster mate (closer to zero) than second.
    return Math.abs(second.value) - Math.abs(best.value);
  }
  // Both cp: simple difference.
  if (best.type === 'cp' && second.type === 'cp') {
    return best.value - second.value;
  }
  // Non-mate vs mate: the mate is better, so the gap is negative
  // (best is worse than second).  This shouldn't happen if results are
  // ordered best-first, but handle it defensively.
  return -Infinity;
}

/**
 * Derive difficulty from the eval gap and search depth.
 *
 * - easy: gap 200–400 cp, any depth
 * - medium: gap 400–700 cp, or gap 200–400 with depth ≥ 20
 * - hard: gap 700–1500 cp, or mate in 4+
 * - brilliant: gap > 1500 cp, or mate in ≤ 3
 */
export function deriveDifficulty(gap: number, depth: number): PuzzleDifficulty {
  if (gap === Infinity) {
    // Mate vs non-mate — always at least hard.
    // We can't know the mate distance from the gap alone, so default to 'hard'.
    return 'hard';
  }
  if (gap > 1500) return 'brilliant';
  if (gap > 700) return 'hard';
  if (gap > 400) return depth >= 20 ? 'hard' : 'medium';
  if (gap >= 200) return depth >= 20 ? 'medium' : 'easy';
  return 'easy';
}

/** Format centipawns as a human-readable string (e.g. 200 → "+2.00"). */
function formatCp(cp: number): string {
  if (cp === Infinity) return '∞';
  if (cp === -Infinity) return '-∞';
  const pawns = cp / 100;
  return pawns >= 0 ? `+${pawns.toFixed(2)}` : pawns.toFixed(2);
}

/**
 * Parse the LLM response for THEME and HINT lines.
 * Expected format:
 *   THEME: <theme text>
 *   HINT: <hint text>
 *
 * Falls back to the full response as the theme if parsing fails.
 */
function parseThemeHint(content: string): { theme: string; hint: string } {
  const lines = content.split('\n');
  let theme = '';
  let hint = '';

  for (const line of lines) {
    const trimmed = line.trim();
    const themeMatch = /^THEME:\s*(.+)$/i.exec(trimmed);
    if (themeMatch) {
      theme = themeMatch[1].trim();
      continue;
    }
    const hintMatch = /^HINT:\s*(.+)$/i.exec(trimmed);
    if (hintMatch) {
      hint = hintMatch[1].trim();
      continue;
    }
  }

  // Fallback: if no THEME line was found, use the first non-empty line.
  if (!theme) {
    theme = lines.find(l => l.trim().length > 0)?.trim() ?? 'Tactical puzzle';
  }
  if (!hint) {
    hint = 'Find the best move.';
  }

  return { theme, hint };
}
