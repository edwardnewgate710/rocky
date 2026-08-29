/**
 * Cache-first analysis orchestration with per-identity single-flight coordination.
 * This module owns cache failure isolation and in-flight lifecycle; callers only supply
 * the engine computation for a validated, capability-routed request.
 */
import type { Clock } from './clock.js';
import { SystemClock } from './clock.js';
import type { AnalysisCache, AnalysisKey } from './cache.js';
import type { AnalysisLimits, EngineResult } from './types.js';
import { CancelledError, ProtocolError } from './errors.js';

export type AnalysisOrchestrationEvent =
  | { readonly type: 'cache_hit'; readonly durationMs: number }
  | { readonly type: 'cache_miss'; readonly durationMs: number }
  | { readonly type: 'cache_read_failure'; readonly durationMs: number }
  | { readonly type: 'cache_write_completed'; readonly durationMs: number }
  | { readonly type: 'cache_write_failure'; readonly durationMs: number }
  | { readonly type: 'engine_computation_started' }
  | { readonly type: 'engine_computation_completed'; readonly durationMs: number }
  | { readonly type: 'request_coalesced' }
  | { readonly type: 'inflight_computation_failure'; readonly durationMs: number }
  | { readonly type: 'cancellation'; readonly scope: 'consumer' | 'shared' }
  | { readonly type: 'cache_result_rejected'; readonly durationMs: number };

export interface AnalysisOrchestrationObserver {
  /** Events contain bounded enums and durations only; no cache keys or request data. */
  record(event: AnalysisOrchestrationEvent): void;
}

export interface AnalysisOrchestratorOptions {
  readonly cache: AnalysisCache;
  readonly clock?: Clock;
  readonly observer?: AnalysisOrchestrationObserver;
}

export interface AnalysisExecution {
  readonly key: AnalysisKey;
  readonly limits: AnalysisLimits;
  readonly signal?: AbortSignal;
  readonly execute: (signal: AbortSignal) => Promise<readonly EngineResult[]>;
}

interface InFlightAnalysis {
  readonly controller: AbortController;
  readonly promise: Promise<readonly EngineResult[]>;
  consumers: number;
  settled: boolean;
}

interface WaitingConsumer {
  readonly identity: string;
  readonly flight: InFlightAnalysis;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (results: readonly EngineResult[]) => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
  finished: boolean;
}

function limitToken(limit: number | undefined): string {
  return limit === undefined ? 'unset' : String(limit);
}

function flightKey(key: AnalysisKey, limits: AnalysisLimits): string {
  return JSON.stringify([
    key.fingerprint,
    key.variant,
    String(key.multiPv),
    key.fen,
    limitToken(limits.depth),
    limitToken(limits.nodes),
    limitToken(limits.timeMs),
  ]);
}

/** Depth/nodes use the weakest line; time remains the Phase A requested-budget contract. */
function achievedLimits(results: readonly EngineResult[], requested: AnalysisLimits): AnalysisLimits {
  return {
    depth: Math.min(...results.map((line) => line.depth)),
    nodes: Math.min(...results.map((line) => line.nodes)),
    ...(requested.timeMs !== undefined ? { timeMs: requested.timeMs } : {}),
  };
}

function isNonNegativeInteger(candidate: unknown): candidate is number {
  return Number.isSafeInteger(candidate) && (candidate as number) >= 0;
}

function isEvaluation(candidate: unknown): boolean {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return false;
  const evaluation = candidate as Record<string, unknown>;
  return (
    (evaluation['type'] === 'cp' || evaluation['type'] === 'mate') &&
    Number.isSafeInteger(evaluation['value'])
  );
}

function hasValidBound(line: Record<string, unknown>): boolean {
  const bound = line['evaluationBound'];
  return bound === undefined || bound === 'lowerbound' || bound === 'upperbound';
}

function hasValidPrincipalVariation(line: Record<string, unknown>): boolean {
  const variation = line['principalVariation'];
  return Array.isArray(variation) && variation.every((move) => typeof move === 'string');
}

function hasValidSearchCounts(line: Record<string, unknown>): boolean {
  return (
    isNonNegativeInteger(line['depth']) &&
    (line['selDepth'] === undefined || isNonNegativeInteger(line['selDepth'])) &&
    isNonNegativeInteger(line['nodes']) &&
    isNonNegativeInteger(line['nps']) &&
    isNonNegativeInteger(line['timeMs'])
  );
}

function isAnalysisLine(candidate: unknown, expectedMultiPv: number): candidate is EngineResult {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return false;
  const line = candidate as Record<string, unknown>;
  return (
    line['multipv'] === expectedMultiPv &&
    isEvaluation(line['evaluation']) &&
    hasValidBound(line) &&
    hasValidPrincipalVariation(line) &&
    hasValidSearchCounts(line)
  );
}

function isAnalysisResultSet(candidate: unknown, multiPv: number): candidate is readonly EngineResult[] {
  return (
    Array.isArray(candidate) &&
    candidate.length > 0 &&
    candidate.length <= multiPv &&
    candidate.every((line, index) => isAnalysisLine(line, index + 1))
  );
}

/**
 * One caller's signal owns only that caller's wait. The shared signal is aborted when
 * the final consumer leaves, and the abandoned flight is removed immediately so a new
 * caller cannot join already-cancelled work. Completion and cancellation race by first
 * observation. If an engine ignores abort and later returns valid output, it is still
 * cached, although every cancelled consumer keeps its cancellation result.
 */
export class AnalysisOrchestrator {
  private readonly cache: AnalysisCache;
  private readonly clock: Clock;
  private readonly observer: AnalysisOrchestrationObserver | undefined;
  private readonly inFlight = new Map<string, InFlightAnalysis>();

  constructor(options: AnalysisOrchestratorOptions) {
    this.cache = options.cache;
    this.clock = options.clock ?? new SystemClock();
    this.observer = options.observer;
  }

  async analyze(execution: AnalysisExecution): Promise<readonly EngineResult[]> {
    this.rejectCancelled(execution.signal);
    const identity = flightKey(execution.key, execution.limits);
    const existing = this.inFlight.get(identity);
    if (existing) {
      this.record({ type: 'request_coalesced' });
      return this.join(identity, existing, execution.signal);
    }
    return this.join(identity, this.start(identity, execution), execution.signal);
  }

  private start(identity: string, execution: AnalysisExecution): InFlightAnalysis {
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => this.resolve(execution, controller.signal));
    const flight: InFlightAnalysis = { controller, promise, consumers: 0, settled: false };
    this.inFlight.set(identity, flight);
    const cleanup = (): void => {
      flight.settled = true;
      if (this.inFlight.get(identity) === flight) this.inFlight.delete(identity);
    };
    void promise.then(cleanup, cleanup);
    return flight;
  }

  private async resolve(
    execution: AnalysisExecution,
    signal: AbortSignal,
  ): Promise<readonly EngineResult[]> {
    const cached = await this.readCache(execution);
    this.rejectCancelled(signal);
    return cached ?? this.compute(execution, signal);
  }

  private join(
    identity: string,
    flight: InFlightAnalysis,
    signal: AbortSignal | undefined,
  ): Promise<readonly EngineResult[]> {
    flight.consumers += 1;
    return new Promise((resolve, reject) => {
      const consumer: WaitingConsumer = {
        identity,
        flight,
        signal,
        resolve,
        reject,
        onAbort: () => this.cancelConsumer(consumer),
        finished: false,
      };
      flight.promise.then(
        (results) => this.resolveConsumer(consumer, results),
        (error) => this.rejectConsumer(consumer, error),
      );
      signal?.addEventListener('abort', consumer.onAbort, { once: true });
      if (signal?.aborted) consumer.onAbort();
    });
  }

  private resolveConsumer(consumer: WaitingConsumer, results: readonly EngineResult[]): void {
    if (this.releaseConsumer(consumer)) consumer.resolve(results);
  }

  private rejectConsumer(consumer: WaitingConsumer, error: unknown): void {
    if (this.releaseConsumer(consumer)) consumer.reject(error);
  }

  private cancelConsumer(consumer: WaitingConsumer): void {
    if (!this.releaseConsumer(consumer)) return;
    this.record({ type: 'cancellation', scope: 'consumer' });
    consumer.reject(new CancelledError());
    this.abortIfAbandoned(consumer.identity, consumer.flight);
  }

  private releaseConsumer(consumer: WaitingConsumer): boolean {
    if (consumer.finished) return false;
    consumer.finished = true;
    consumer.signal?.removeEventListener('abort', consumer.onAbort);
    consumer.flight.consumers -= 1;
    return true;
  }

  private abortIfAbandoned(identity: string, flight: InFlightAnalysis): void {
    if (flight.consumers !== 0 || flight.settled) return;
    if (this.inFlight.get(identity) === flight) this.inFlight.delete(identity);
    this.record({ type: 'cancellation', scope: 'shared' });
    flight.controller.abort();
  }

  private async compute(
    execution: AnalysisExecution,
    signal: AbortSignal,
  ): Promise<readonly EngineResult[]> {
    const startedAt = this.clock.now();
    this.record({ type: 'engine_computation_started' });
    try {
      const results = await execution.execute(signal);
      if (!isAnalysisResultSet(results, execution.key.multiPv)) {
        throw new ProtocolError('Engine returned malformed analysis results.');
      }
      this.record({ type: 'engine_computation_completed', durationMs: this.clock.now() - startedAt });
      await this.writeCache(execution, results);
      return results;
    } catch (error) {
      if (!signal.aborted && !(error instanceof CancelledError)) {
        this.record({ type: 'inflight_computation_failure', durationMs: this.clock.now() - startedAt });
      }
      throw error;
    }
  }

  private async readCache(execution: AnalysisExecution): Promise<readonly EngineResult[] | undefined> {
    const startedAt = this.clock.now();
    try {
      const cached = await this.cache.get(execution.key, execution.limits);
      if (cached !== undefined && !isAnalysisResultSet(cached, execution.key.multiPv)) {
        this.record({ type: 'cache_result_rejected', durationMs: this.clock.now() - startedAt });
        return undefined;
      }
      this.record({
        type: cached === undefined ? 'cache_miss' : 'cache_hit',
        durationMs: this.clock.now() - startedAt,
      });
      return cached;
    } catch {
      this.record({ type: 'cache_read_failure', durationMs: this.clock.now() - startedAt });
      return undefined;
    }
  }

  private async writeCache(execution: AnalysisExecution, results: readonly EngineResult[]): Promise<void> {
    const startedAt = this.clock.now();
    try {
      await this.cache.set(execution.key, results, {
        limits: achievedLimits(results, execution.limits),
      });
      this.record({ type: 'cache_write_completed', durationMs: this.clock.now() - startedAt });
    } catch {
      this.record({ type: 'cache_write_failure', durationMs: this.clock.now() - startedAt });
    }
  }

  private record(event: AnalysisOrchestrationEvent): void {
    try {
      this.observer?.record(event);
    } catch {
      // Observability cannot become an analysis availability dependency.
    }
  }

  private rejectCancelled(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) return;
    this.record({ type: 'cancellation', scope: 'consumer' });
    throw new CancelledError();
  }
}
