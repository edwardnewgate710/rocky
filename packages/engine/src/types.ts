/**
 * Core value types for the engine bridge. These are pure data — no behaviour, no
 * dependencies — shared across every seam (transport, instance, pool, manager, cache).
 */

/**
 * Scheduling priority classes. Lower ordinal = served first. Chosen so a burst of
 * background batch work (e.g. post-tournament anti-cheat analysis) can never starve a
 * human waiting on a bot move.
 */
export enum JobPriority {
  /** A human is on the clock waiting for the bot to move. */
  BotMove = 0,
  /** A user is watching an eval bar / hint update. */
  LiveAnalysis = 1,
  /** Tournament or anti-cheat batch analysis. */
  Batch = 2,
  /** Opening-book building, precompute, and other opportunistic work. */
  Background = 3,
}

/** At least one field must be set; the deepest/longest wins when several are present. */
export interface AnalysisLimits {
  readonly depth?: number;
  readonly nodes?: number;
  readonly timeMs?: number;
}

export type EvaluationKind = 'cp' | 'mate';
export type EvaluationBound = 'lowerbound' | 'upperbound';

/**
 * An evaluation from the perspective of the side to move.
 * - `cp`: centipawns (positive = side to move is better).
 * - `mate`: signed moves-to-mate (positive = side to move mates, negative = gets mated).
 */
export interface Evaluation {
  readonly type: EvaluationKind;
  readonly value: number;
}

/**
 * One fully-resolved analysis line. When `multiPv > 1` a call returns one
 * {@link EngineResult} per requested line, ordered best-first (`multipv` 1..N).
 */
export interface EngineResult {
  readonly multipv: number;
  readonly evaluation: Evaluation;
  /** Present when UCI reports an aspiration-search bound rather than an exact score. */
  readonly evaluationBound?: EvaluationBound;
  readonly principalVariation: readonly string[];
  readonly depth: number;
  readonly selDepth?: number;
  readonly nodes: number;
  readonly nps: number;
  readonly timeMs: number;
}

/** Per-instance engine configuration applied via `setoption` after the handshake. */
export interface EngineConfig {
  readonly threads?: number;
  readonly hashMb?: number;
  /** Extra raw UCI options (validated against discovered capabilities before sending). */
  readonly options?: Readonly<Record<string, string | number | boolean>>;
}

export type UciOptionType = 'check' | 'spin' | 'combo' | 'button' | 'string';

/** A single UCI option as advertised by the engine during the `uci` handshake. */
export interface UciOptionSpec {
  readonly name: string;
  readonly type: UciOptionType;
  readonly default?: string;
  readonly min?: number;
  readonly max?: number;
  readonly vars?: readonly string[];
}

/**
 * What an engine build can actually do, discovered from the `uci` handshake rather
 * than hard-coded per engine name. Drives routing, option validation, and bot strategy.
 */
export interface EngineCapabilities {
  readonly engineName: string;
  readonly engineAuthor: string;
  readonly version: string;
  /** Stable digest of the engine name, version, and advertised option contracts. */
  readonly fingerprint: string;
  readonly variants: ReadonlySet<string>;
  readonly options: ReadonlyMap<string, UciOptionSpec>;
  readonly supportsMultiPv: boolean;
  readonly supportsLimitStrength: boolean;
  readonly supportsSkillLevel: boolean;
  readonly supportsPonder: boolean;
  readonly maxThreads?: number;
  readonly maxHashMb?: number;
}

export type Health = 'healthy' | 'degraded' | 'unhealthy';
export type BreakerState = 'closed' | 'open' | 'half-open';

export interface WorkerHealth {
  readonly id: string;
  readonly state: Health;
  readonly busy: boolean;
  readonly jobsCompleted: number;
  /** `clock.now()` of the last successful `readyok`, or `null` if never ready. */
  readonly lastReadyOkMs: number | null;
}

export interface PoolHealth {
  readonly plugin: string;
  readonly ready: number;
  readonly target: number;
  readonly breaker: BreakerState;
  readonly queueDepth: number;
  readonly workers: readonly WorkerHealth[];
}

export interface ManagerHealth {
  readonly status: Health;
  readonly pools: readonly PoolHealth[];
  readonly totalQueueDepth: number;
}
