/**
 * The top-level abstraction every caller depends on. Callers ask for analysis or a
 * move by *intent* — they never know whether a UCI subprocess, an in-process NNUE
 * evaluator, a remote worker, or (future) an LLM-grounded analyzer served the request.
 * A UCI engine pool is one implementation; the {@link EngineManager} is another that
 * routes across many.
 */
import type { AnalysisLimits, EngineCapabilities, EngineResult, JobPriority } from './types.js';

export interface AnalysisRequest {
  /** FEN of the position to analyze. Validated before it reaches a worker. */
  readonly fen: string;
  readonly variant: string;
  readonly limits: AnalysisLimits;
  /** Number of lines to return (defaults to 1). */
  readonly multiPv?: number;
  readonly priority?: JobPriority;
  /** Cooperative cancellation: aborting removes a queued job or `stop`s an in-flight one. */
  readonly signal?: AbortSignal;
}

/** Target playing strength for a bot. `elo` uses `UCI_LimitStrength`; `skill` uses `Skill Level`. */
export interface StrengthSpec {
  readonly elo?: number;
  readonly skill?: number;
}

export interface PlayRequest {
  readonly fen: string;
  readonly variant: string;
  readonly limits: AnalysisLimits;
  readonly strength?: StrengthSpec;
  readonly priority?: JobPriority;
  readonly signal?: AbortSignal;
}

export interface PlayResult {
  /** The chosen move in UCI long algebraic notation (e.g. `e2e4`, `e7e8q`). */
  readonly move: string;
  /** The engine's expected reply, if it reported one. */
  readonly ponder?: string;
  /** The analysis line backing the move, when available. */
  readonly line?: EngineResult;
}

export interface AnalysisProvider {
  analyze(request: AnalysisRequest): Promise<readonly EngineResult[]>;
  play(request: PlayRequest): Promise<PlayResult>;
  /**
   * Discovered capabilities of the engine that would serve `variant`, or `undefined`
   * if none is registered/ready. Replaces name-based conditionals at call sites.
   */
  capabilitiesFor(variant: string): EngineCapabilities | undefined;
}
