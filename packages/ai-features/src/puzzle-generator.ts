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

import type {
  GeneratePuzzleRequest,
  PuzzleResult,
  Puzzle,
  PuzzleRejection,
  PuzzleDifficulty,
  PuzzleEvidence,
  PuzzleInsufficientReason,
} from './puzzle-types.js';

/** Options for constructing a `PuzzleGenerator`. */
export interface PuzzleGeneratorOptions {
  /** The chess engine analysis provider (M5 port). Injected — never a real binary in tests. */
  readonly engine?: AnalysisProvider;
  /** The AI completion provider (M7 port). Optional — the LLM text is additive, never load-bearing. */
  readonly ai?: AiProvider;
  /** Default variant in the platform vocabulary (defaults to `standard`). */
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
  private readonly engine: AnalysisProvider | undefined;
  private readonly ai: AiProvider | undefined;
  private readonly defaultVariant: string;
  private readonly defaultLimits: AnalysisLimits;
  private readonly defaultMultiPv: number;
  private readonly defaultSharpnessThreshold: number;
  private readonly temperature: number;
  private readonly maxTokens: number;

  constructor(options: PuzzleGeneratorOptions = {}) {
    this.engine = options.engine;
    this.ai = options.ai;
    this.defaultVariant = options.defaultVariant ?? 'standard';
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
   * @returns A verified puzzle, a supported rejection, or explicit insufficient evidence.
   */
  async generate(request: GeneratePuzzleRequest): Promise<PuzzleResult> {
    const variant = request.variant ?? this.defaultVariant;
    const limits = request.limits ?? this.defaultLimits;
    const multiPv = request.multiPv ?? this.defaultMultiPv;
    const configuredThreshold = finiteThreshold(this.defaultSharpnessThreshold)
      ? this.defaultSharpnessThreshold
      : DEFAULT_SHARPNESS_THRESHOLD;
    const threshold = finiteThreshold(request.sharpnessThreshold)
      ? request.sharpnessThreshold
      : configuredThreshold;

    // 1. Obtain engine analysis (multi-PV).
    let results: readonly EngineResult[];
    if (request.analysis !== undefined) {
      results = request.analysis;
    } else {
      if (!this.engine) {
        throw new Error('PuzzleGenerator requires pre-computed analysis when no engine is configured.');
      }
      const analysisRequest: AnalysisRequest = {
        fen: request.fen,
        variant,
        limits,
        multiPv,
        signal: request.signal,
      };
      results = await this.engine.analyze(analysisRequest);
    }

    // 2. A puzzle is a comparison, not merely a best line. Partial engine output is neither a
    // puzzle nor evidence that the position is quiet.
    if (results.length < 2) {
      return insufficient(request.fen, 'not_enough_lines', results[0], undefined);
    }

    const best = results.find((line) => line.multipv === 1);
    if (!best) return insufficient(request.fen, 'missing_best_line', undefined, undefined);
    const second = results.find((line) => line.multipv === 2);
    if (!second) return insufficient(request.fen, 'missing_comparison_line', best, undefined);

    const requiredMultiPv = request.analysis === undefined ? multiPv : request.multiPv ?? 2;
    const exactMultiPv = request.analysis === undefined || request.multiPv !== undefined;
    const requiredLines = completeMultiPv(results, requiredMultiPv, exactMultiPv);
    if (!requiredLines) return insufficient(request.fen, 'incomplete_multipv', best, second);

    const bestMove = best.principalVariation[0] ?? null;
    const comparisonMove = second.principalVariation[0] ?? null;
    if (bestMove === null) return insufficient(request.fen, 'missing_best_move', best, second);
    if (comparisonMove === null) {
      return insufficient(request.fen, 'missing_comparison_move', best, second);
    }
    if (!UCI_MOVE.test(bestMove)) return insufficient(request.fen, 'invalid_best_move', best, second);
    if (!UCI_MOVE.test(comparisonMove)) {
      return insufficient(request.fen, 'invalid_comparison_move', best, second);
    }
    if (bestMove === comparisonMove) {
      return insufficient(request.fen, 'duplicate_moves', best, second);
    }
    if (!best.principalVariation.every((move) => UCI_MOVE.test(move))) {
      return insufficient(request.fen, 'invalid_solution_line', best, second);
    }
    if (requiredLines.some((line) => !Number.isFinite(line.evaluation.value))) {
      return insufficient(request.fen, 'non_finite_evaluation', best, second);
    }
    if (requiredLines.some((line) => line.evaluationBound !== undefined)) {
      return insufficient(request.fen, 'bounded_evaluation', best, second);
    }
    if (requiredLines.some((line) => {
      const move = line.principalVariation[0];
      return move === undefined || !UCI_MOVE.test(move);
    })) {
      return insufficient(request.fen, 'incomplete_multipv', best, second);
    }
    if (requiredLines.some((line) => !Number.isInteger(line.depth))) {
      return insufficient(request.fen, 'non_finite_depth', best, second);
    }
    const requiredDepth = request.analysis === undefined ? limits.depth : request.limits?.depth;
    if (
      requiredLines.some((line) => line.depth <= 0) ||
      (requiredDepth !== undefined && requiredLines.some((line) => line.depth < requiredDepth))
    ) {
      return insufficient(request.fen, 'incomplete_depth', best, second);
    }
    if (requiredLines.some((line) => line.depth !== best.depth)) {
      return insufficient(request.fen, 'mismatched_depth', best, second);
    }
    if (
      best.evaluation.type === 'cp' &&
      second.evaluation.type === 'cp' &&
      !Number.isFinite(best.evaluation.value - second.evaluation.value)
    ) {
      return insufficient(request.fen, 'non_finite_evaluation', best, second);
    }

    // 3. Compare like with like. Mate scores are not very large pawn scores and must never be
    // represented by Infinity simply to pass a centipawn threshold.
    const comparison = compareEvidence(best.evaluation, second.evaluation, threshold);
    if (!comparison) return insufficient(request.fen, 'unordered_lines', best, second);

    if (!comparison.qualifies) {
      const rejection: PuzzleRejection = {
        kind: 'rejection',
        fen: request.fen,
        evidence: comparison.evidence,
        thresholdCp: threshold,
        reason: comparison.evidence.kind === 'centipawn_gap'
          ? 'gap_below_threshold'
          : 'mate_not_unique',
        bestMove,
        comparisonMove,
        bestEval: best.evaluation,
        secondBestEval: second.evaluation,
        depth: best.depth,
      };
      return rejection;
    }

    // 5. Derive difficulty from the gap and depth.
    const difficulty = comparison.evidence.kind === 'centipawn_gap'
      ? deriveDifficulty(comparison.evidence.gapCp, best.depth)
      : 'hard';

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
      solutionMove: bestMove,
      comparisonMove,
      bestEval: best.evaluation,
      bestEvalLabel: evalToString(best.evaluation),
      secondBestEval: second.evaluation,
      secondBestEvalLabel: evalToString(second.evaluation),
      evidence: comparison.evidence,
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
 * Compute a centipawn gap only when both lines are finite centipawn evaluations.
 *
 * Mate comparisons intentionally return `null`: mate distance and pawn value do not share a scale,
 * and callers must use the tagged evidence produced by {@link PuzzleGenerator} instead.
 */
export function evalGapCp(best: Evaluation, second: Evaluation): number | null {
  if (best.type !== 'cp' || second.type !== 'cp') return null;
  if (!Number.isFinite(best.value) || !Number.isFinite(second.value)) return null;
  const gap = best.value - second.value;
  return Number.isFinite(gap) ? gap : null;
}

/**
 * Derive difficulty from the eval gap and search depth.
 *
 * - easy: gap 200–400 cp with depth < 20, or gap < 200 cp
 * - medium: gap 400–700 cp, or gap 200–400 with depth ≥ 20
 * - hard: gap 700–1500 cp
 * - brilliant: gap > 1500 cp
 *
 * Mate evidence is classified separately by `PuzzleGenerator` and currently maps to `hard`.
 */
export function deriveDifficulty(gap: number, depth: number): PuzzleDifficulty {
  if (gap > 1500) return 'brilliant';
  if (gap > 700) return 'hard';
  if (gap > 400) return depth >= 20 ? 'hard' : 'medium';
  if (gap >= 200) return depth >= 20 ? 'medium' : 'easy';
  return 'easy';
}

const UCI_MOVE = /^(?:[a-h][1-8][a-h][1-8][qrbn]?|[PNBRQ]@[a-h][1-8])$/;
const MIN_MATE_DISTANCE_GAP = 2;

function finiteThreshold(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function completeMultiPv(
  results: readonly EngineResult[],
  requiredMultiPv: number,
  exact: boolean,
): readonly EngineResult[] | null {
  if (
    !Number.isInteger(requiredMultiPv) ||
    requiredMultiPv < 2 ||
    results.length < requiredMultiPv ||
    (exact && results.length !== requiredMultiPv)
  ) {
    return null;
  }
  const byRank = new Map<number, EngineResult>();
  for (const line of results) {
    if (byRank.has(line.multipv)) return null;
    byRank.set(line.multipv, line);
  }
  const required = Array.from({ length: requiredMultiPv }, (_, index) => byRank.get(index + 1));
  return required.every((line): line is EngineResult => line !== undefined) ? required : null;
}

function insufficient(
  fen: string,
  reason: PuzzleInsufficientReason,
  best: EngineResult | undefined,
  second: EngineResult | undefined,
): PuzzleResult {
  const bestMove = best?.principalVariation[0];
  const comparisonMove = second?.principalVariation[0];
  return {
    kind: 'insufficient',
    fen,
    reason,
    bestMove: bestMove && UCI_MOVE.test(bestMove) ? bestMove : null,
    comparisonMove: comparisonMove && UCI_MOVE.test(comparisonMove) ? comparisonMove : null,
  };
}

function compareEvidence(
  best: Evaluation,
  second: Evaluation,
  thresholdCp: number,
): { evidence: PuzzleEvidence; qualifies: boolean } | null {
  if (best.type === 'cp' && second.type === 'cp') {
    const gapCp = best.value - second.value;
    if (gapCp < 0) return null;
    return { evidence: { kind: 'centipawn_gap', gapCp }, qualifies: gapCp >= thresholdCp };
  }

  if (best.type === 'mate' && second.type === 'mate') {
    if (best.value === 0 || second.value === 0) return null;
    if (best.value > 0 && second.value > 0) {
      const distanceGap = Math.abs(second.value) - Math.abs(best.value);
      if (distanceGap < 0) return null;
      return {
        evidence: { kind: 'mate', relation: 'faster_mate', distanceGap },
        qualifies: distanceGap >= MIN_MATE_DISTANCE_GAP,
      };
    }
    if (best.value < 0 && second.value < 0) {
      const distanceGap = Math.abs(best.value) - Math.abs(second.value);
      if (distanceGap < 0) return null;
      return {
        evidence: { kind: 'mate', relation: 'delays_mate', distanceGap },
        qualifies: distanceGap >= MIN_MATE_DISTANCE_GAP,
      };
    }
    if (best.value > 0 && second.value < 0) {
      return {
        evidence: { kind: 'mate', relation: 'forces_mate', distanceGap: null },
        qualifies: true,
      };
    }
    return null;
  }

  if (best.type === 'mate') {
    if (best.value <= 0) return null;
    return {
      evidence: { kind: 'mate', relation: 'forces_mate', distanceGap: null },
      qualifies: true,
    };
  }

  if (second.type === 'mate') {
    if (second.value >= 0) return null;
    return {
      evidence: { kind: 'mate', relation: 'avoids_mate', distanceGap: null },
      qualifies: true,
    };
  }

  return null;
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
