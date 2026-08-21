/**
 * `@chess-platform/engine` — provider-agnostic chess engine bridge.
 *
 * Public surface, layered top-down: {@link AnalysisProvider} (what callers depend on) →
 * {@link EngineManager} (orchestrator) → {@link EnginePool} → {@link UciEngineInstance} →
 * {@link EngineTransport}, with {@link EnginePlugin}, {@link AnalysisCache}, and
 * {@link FenValidator} as the pluggable seams.
 */

// Value types & enums
export { JobPriority } from './types.js';
export type {
  AnalysisLimits,
  Evaluation,
  EvaluationBound,
  EvaluationKind,
  EngineResult,
  EngineConfig,
  UciOptionType,
  UciOptionSpec,
  EngineCapabilities,
  Health,
  BreakerState,
  WorkerHealth,
  PoolHealth,
  ManagerHealth,
} from './types.js';

// Provider contract
export type { AnalysisProvider, AnalysisRequest, PlayRequest, PlayResult, StrengthSpec } from './provider.js';

// Errors
export {
  EngineError,
  InvalidFenError,
  NoEngineForVariantError,
  EngineCrashError,
  EngineTimeoutError,
  EngineVersionError,
  ProtocolError,
  QueueFullError,
  CircuitOpenError,
  CancelledError,
  ShuttingDownError,
} from './errors.js';
export type { EngineErrorCode } from './errors.js';

// Clock seam
export { SystemClock } from './clock.js';
export type { Clock, TimerHandle } from './clock.js';

// FEN validation seam
export { StructuralFenValidator, structuralFenValidator } from './fen.js';
export type { FenValidator } from './fen.js';

// Transport seam
export { FakeEngineTransport } from './transport.js';
export { ChildProcessTransport } from './child-process-transport.js';
export type {
  EngineTransport,
  LineListener,
  ExitListener,
  FakeEngineOptions,
  FakeGoResponse,
  FakeGoHandler,
} from './transport.js';
export type { ChildProcessTransportOptions } from './child-process-transport.js';

// UCI codec
export {
  parseInfoLine,
  parseBestMove,
  parseIdLine,
  parseOptionLine,
  buildPositionCommand,
  buildGoCommand,
  buildSetOption,
} from './uci/protocol.js';
export type { ParsedInfoLine, ParsedBestMove, ParsedIdLine } from './uci/protocol.js';

// Capabilities & versioning
export { buildCapabilities, computeFingerprint, extractVersion, compareVersions, negotiateVersion } from './capabilities.js';

// Cache seam
export { NullCache, InMemoryLruCache, limitsSatisfy, cacheKeyString } from './cache.js';
export type { AnalysisCache, AnalysisKey, CacheMeta } from './cache.js';

// Scheduler
export { PriorityScheduler } from './queue.js';
export type { ScheduledEntry, SchedulerOptions } from './queue.js';

// Instance
export { UciEngineInstance } from './instance.js';
export type { EngineInstance, EngineInstanceOptions, AnalyzeParams, PlayParams, EngineOption, DeadInfo } from './instance.js';

// Plugins
export { stockfishPlugin, fairyStockfishPlugin, builtinPlugins } from './plugin.js';
export type { EnginePlugin, CreateInstanceOptions } from './plugin.js';

// Pool
export { EnginePool } from './pool.js';
export type { EnginePoolOptions, CircuitBreakerOptions, TransportFactory } from './pool.js';

// Manager & composition root
export { EngineManager } from './manager.js';
export type { EngineManagerOptions } from './manager.js';
export { createEngineManager, EnvBinaryResolver } from './bootstrap.js';
export type { CreateEngineManagerOptions, BinaryResolver, ResolvedBinary } from './bootstrap.js';
