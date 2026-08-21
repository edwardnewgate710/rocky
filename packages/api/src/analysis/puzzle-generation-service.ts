/**
 * Production puzzle generation over the API-owned analysis subsystem.
 *
 * The service owns every cost and classification policy. It asks {@link AnalysisService} for one
 * three-line search, then hands those already-computed lines to an engineless `PuzzleGenerator`.
 * There is therefore one acquisition path and no second pool for the library feature to reach.
 */
import type { Evaluation } from '@chess-platform/engine';
import type { Variant } from '@chess-platform/core';
import {
  DEFAULT_SHARPNESS_THRESHOLD,
  PuzzleGenerator,
} from '@chess-platform/ai-features';
import type {
  PuzzleDifficulty,
  PuzzleEvidence,
  PuzzleInsufficientReason,
} from '@chess-platform/ai-features';
import { HttpError } from '../http/errors.js';
import { DEFAULT_ANALYSIS_LIMITS } from './limits.js';
import type { AnalysisService } from './service.js';
import { coreFenValidator } from './fen-validator.js';
import { terminalOutcome } from './terminal.js';

/** One MultiPV acquisition supplies the solution, comparison and spare line for engine stability. */
export const PUZZLE_MULTI_PV = 3;
/** Fixed at the existing production analysis default; callers cannot widen either bound. */
export const PUZZLE_DEPTH = DEFAULT_ANALYSIS_LIMITS.defaultDepth;
export const PUZZLE_MOVETIME_MS = DEFAULT_ANALYSIS_LIMITS.defaultTimeMs;
/** The M8 objective sharpness rule, now explicitly server-owned. */
export const PUZZLE_GAP_THRESHOLD_CP = DEFAULT_SHARPNESS_THRESHOLD;

/** Exact analysis policy required before the capability may be advertised. */
export const PUZZLE_ANALYSIS_LIMITS = {
  depth: PUZZLE_DEPTH,
  movetimeMs: PUZZLE_MOVETIME_MS,
  multiPv: PUZZLE_MULTI_PV,
} as const;

export interface PuzzleGenerationInput {
  readonly fen: string;
  readonly variant: Variant;
}

interface PuzzleEvidenceOutcome {
  readonly fen: string;
  readonly variant: Variant;
  readonly evidence: PuzzleEvidence;
  readonly bestMove: string;
  readonly comparisonMove: string;
  readonly bestEvaluation: Evaluation;
  readonly comparisonEvaluation: Evaluation;
  readonly depth: number;
}

export type PuzzleGenerationOutcome =
  | (PuzzleEvidenceOutcome & {
      readonly kind: 'puzzle';
      readonly solutionMove: string;
      readonly solutionLine: readonly string[];
      readonly difficulty: PuzzleDifficulty;
    })
  | (PuzzleEvidenceOutcome & { readonly kind: 'no_tactic' })
  | {
      readonly kind: 'insufficient';
      readonly fen: string;
      readonly variant: Variant;
      readonly reason: PuzzleInsufficientReason | 'terminal_position';
      readonly bestMove: string | null;
      readonly comparisonMove: string | null;
      readonly terminal?: {
        readonly reason: string;
        readonly result: '1-0' | '0-1' | '1/2-1/2';
      };
    };

export interface PuzzleGenerationServiceOptions {
  readonly analysis: AnalysisService;
}

export class PuzzleGenerationService {
  private readonly analysis: AnalysisService;
  /** No engine and no AI provider: pre-computed analysis is the only executable path. */
  private readonly generator = new PuzzleGenerator({
    defaultVariant: 'standard',
    defaultSharpnessThreshold: PUZZLE_GAP_THRESHOLD_CP,
    defaultMultiPv: PUZZLE_MULTI_PV,
  });

  constructor(options: PuzzleGenerationServiceOptions) {
    if (!options.analysis.canSatisfyLimits(PUZZLE_ANALYSIS_LIMITS)) {
      throw new Error('Puzzle generation requires the fixed depth, time, and MultiPV policy.');
    }
    this.analysis = options.analysis;
  }

  supportsVariant(variant: string): boolean {
    return this.analysis.supportsMultiPv(variant, PUZZLE_MULTI_PV);
  }

  /**
   * Generate a puzzle conclusion for one exact position.
   *
   * `onAccepted` runs after cheap validation and terminal adjudication, but before the one engine
   * search. Routes use it to spend the expensive-work quota only when work will actually begin.
   */
  async generate(
    input: PuzzleGenerationInput,
    onAccepted?: () => Promise<void>,
  ): Promise<PuzzleGenerationOutcome> {
    if (!this.supportsVariant(input.variant)) {
      throw HttpError.validation('unsupported variant', { variant: 'unsupported variant' });
    }

    try {
      coreFenValidator.validate(input.fen, input.variant);
    } catch {
      throw HttpError.validation('invalid FEN', { fen: 'invalid FEN' });
    }

    const terminal = terminalOutcome(input.fen, input.variant);
    if (terminal) {
      return {
        kind: 'insufficient',
        fen: input.fen,
        variant: input.variant,
        reason: 'terminal_position',
        bestMove: null,
        comparisonMove: null,
        terminal: { reason: terminal.reason, result: terminal.result },
      };
    }

    if (onAccepted) await onAccepted();

    const analysis = await this.analysis.analyze({
      fen: input.fen,
      variant: input.variant,
      ...PUZZLE_ANALYSIS_LIMITS,
    });

    // Defensive parity with the pre-charge adjudication. AnalysisService is authoritative for
    // terminal positions too; if its contract changes, never reinterpret an empty result as quiet.
    if (analysis.terminal) {
      return {
        kind: 'insufficient',
        fen: input.fen,
        variant: input.variant,
        reason: 'terminal_position',
        bestMove: null,
        comparisonMove: null,
        terminal: { reason: analysis.terminal.reason, result: analysis.terminal.result },
      };
    }

    const result = await this.generator.generate({
      fen: input.fen,
      variant: input.variant,
      analysis: analysis.lines,
      limits: { depth: PUZZLE_DEPTH },
      multiPv: PUZZLE_MULTI_PV,
      sharpnessThreshold: PUZZLE_GAP_THRESHOLD_CP,
    });

    if (result.kind === 'insufficient') {
      return {
        kind: 'insufficient',
        fen: input.fen,
        variant: input.variant,
        reason: result.reason,
        bestMove: result.bestMove,
        comparisonMove: result.comparisonMove,
      };
    }

    const common: PuzzleEvidenceOutcome = {
      fen: input.fen,
      variant: input.variant,
      evidence: result.evidence,
      bestMove: result.kind === 'puzzle' ? result.solutionMove : result.bestMove,
      comparisonMove: result.comparisonMove,
      bestEvaluation: result.bestEval,
      comparisonEvaluation: result.secondBestEval,
      depth: result.depth,
    };

    if (result.kind === 'rejection') return { ...common, kind: 'no_tactic' };
    return {
      ...common,
      kind: 'puzzle',
      solutionMove: result.solutionMove,
      solutionLine: [...result.solutionLine],
      difficulty: result.difficulty,
    };
  }
}
