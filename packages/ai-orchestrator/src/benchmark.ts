/**
 * Benchmark framework.  Compares providers on curated chess tasks using
 * latency, success rate, token usage, cost, and response quality
 * (where measurable via engine-grounded verification).
 *
 * The framework generates reusable benchmark reports that can inform
 * routing weights.
 */

import type { AiProvider } from './provider.js';
import type {
  CompletionRequest,
  CompletionResponse,
  EngineGrounding,
  Message,
  TaskClass,
} from './types.js';
import type { BenchmarkConfig } from './config.js';
import { DEFAULTS } from './config.js';

/** A single benchmark task. */
export interface BenchmarkTask {
  readonly id: string;
  readonly description: string;
  readonly task: TaskClass;
  readonly messages: readonly Message[];
  readonly grounding?: EngineGrounding;
  /** Expected content fragments (for quality scoring). */
  readonly expectedFragments?: readonly string[];
}

/** Per-provider result for a single task. */
export interface TaskResult {
  readonly taskId: string;
  readonly providerId: string;
  readonly model: string;
  readonly success: boolean;
  readonly latencyMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costMicroUsd: number;
  readonly qualityScore: number; // 0–1
  readonly errorMessage?: string;
  readonly response?: CompletionResponse;
}

/** Aggregated benchmark report. */
export interface BenchmarkReport {
  readonly timestamp: number;
  readonly results: readonly TaskResult[];
  readonly summary: readonly ProviderSummary[];
}

export interface ProviderSummary {
  readonly providerId: string;
  readonly model: string;
  readonly taskCount: number;
  readonly successRate: number;
  readonly avgLatencyMs: number;
  readonly avgCostMicroUsd: number;
  readonly avgQualityScore: number;
  readonly totalTokens: number;
}

/**
 * The benchmark runner.  Executes a suite of tasks against one or more
 * providers and produces a report.
 */
export class BenchmarkRunner {
  private readonly config: Required<BenchmarkConfig>;

  constructor(config?: BenchmarkConfig) {
    this.config = {
      warmupIterations: config?.warmupIterations ?? DEFAULTS.benchmark.warmupIterations,
      measuredIterations: config?.measuredIterations ?? DEFAULTS.benchmark.measuredIterations,
      timeoutMs: config?.timeoutMs ?? DEFAULTS.benchmark.timeoutMs,
    };
  }

  /**
   * Run a benchmark suite against one or more providers.
   * Each task is run `measuredIterations` times (after `warmupIterations`).
   */
  async run(
    tasks: readonly BenchmarkTask[],
    providers: readonly AiProvider[],
  ): Promise<BenchmarkReport> {
    const results: TaskResult[] = [];

    for (const task of tasks) {
      for (const provider of providers) {
        // Warmup
        for (let i = 0; i < this.config.warmupIterations; i++) {
          await this.runOnce(provider, task).catch(() => {});
        }
        // Measured
        for (let i = 0; i < this.config.measuredIterations; i++) {
          const result = await this.runOnce(provider, task);
          results.push(result);
        }
      }
    }

    const summary = this.summarise(results);
    return { timestamp: Date.now(), results, summary };
  }

  private async runOnce(
    provider: AiProvider,
    task: BenchmarkTask,
  ): Promise<TaskResult> {
    const request: CompletionRequest = {
      task: task.task,
      messages: task.messages,
      grounding: task.grounding,
      maxTokens: 500,
    };

    const start = Date.now();
    try {
      const response = await this.withTimeout(
        provider.complete(request),
        this.config.timeoutMs,
      );
      const latencyMs = Date.now() - start;
      const qualityScore = this.scoreQuality(response, task);
      return {
        taskId: task.id,
        providerId: provider.id,
        model: response.model,
        success: true,
        latencyMs,
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        costMicroUsd: response.costMicroUsd,
        qualityScore,
        response,
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      return {
        taskId: task.id,
        providerId: provider.id,
        model: 'unknown',
        success: false,
        latencyMs,
        promptTokens: 0,
        completionTokens: 0,
        costMicroUsd: 0,
        qualityScore: 0,
        errorMessage: (err as Error).message,
      };
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Benchmark timeout after ${ms}ms`)), ms),
      ),
    ]);
  }

  private scoreQuality(response: CompletionResponse, task: BenchmarkTask): number {
    if (!task.expectedFragments || task.expectedFragments.length === 0) {
      // No quality check defined — return 1.0 for successful responses.
      return 1;
    }
    const content = response.content.toLowerCase();
    const hits = task.expectedFragments.filter((f) =>
      content.includes(f.toLowerCase()),
    );
    return hits.length / task.expectedFragments.length;
  }

  private summarise(results: readonly TaskResult[]): readonly ProviderSummary[] {
    const byProvider = new Map<string, TaskResult[]>();
    for (const r of results) {
      const key = `${r.providerId}|${r.model}`;
      const list = byProvider.get(key) ?? [];
      list.push(r);
      byProvider.set(key, list);
    }
    return [...byProvider.entries()].map(([key, rs]) => {
      const [providerId, model] = key.split('|');
      const successes = rs.filter((r) => r.success);
      return {
        providerId,
        model,
        taskCount: rs.length,
        successRate: rs.length > 0 ? successes.length / rs.length : 0,
        avgLatencyMs: successes.length > 0
          ? Math.round(successes.reduce((s, r) => s + r.latencyMs, 0) / successes.length)
          : 0,
        avgCostMicroUsd: successes.length > 0
          ? Math.round(successes.reduce((s, r) => s + r.costMicroUsd, 0) / successes.length)
          : 0,
        avgQualityScore: successes.length > 0
          ? successes.reduce((s, r) => s + r.qualityScore, 0) / successes.length
          : 0,
        totalTokens: rs.reduce((s, r) => s + r.promptTokens + r.completionTokens, 0),
      };
    });
  }
}

/**
 * A curated set of chess benchmark tasks for the acceptance criteria.
 * These tasks test move explanation, coaching, and grounded reasoning.
 */
export const CHESS_BENCHMARK_TASKS: readonly BenchmarkTask[] = [
  {
    id: 'explain-fools-mate',
    description: 'Explain why f3 is a weak opening move',
    task: 'explanation',
    messages: [
      { role: 'user', content: 'Why is 1.f3 a weak opening move? Explain briefly.' },
    ],
    grounding: {
      fen: 'rnbqkbnr/pppppppp/8/5P2/8/8/PPPPP1PP/RNBQKBNR b KQkq - 0 1',
      moveUci: 'f2f3',
      evalCp: -30,
      depth: 15,
      bestLine: ['e7e5', 'g1f3', 'b8c6', 'b1c3'],
    },
    expectedFragments: ['weak', 'king', 'pawn', 'exposed'],
  },
  {
    id: 'coach-blunder',
    description: 'Identify the blunder in a given position',
    task: 'coach',
    messages: [
      { role: 'user', content: 'What is the biggest mistake in this position? What should be played instead?' },
    ],
    grounding: {
      fen: 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 0 3',
      evalMate: -1,
      depth: 20,
      bestLine: ['g1f3'],
    },
    expectedFragments: ['checkmate', 'queen', 'h4'],
  },
  {
    id: 'general-knowledge',
    description: 'General chess knowledge question',
    task: 'general',
    messages: [
      { role: 'user', content: 'What is the Sicilian Defense and why is it popular?' },
    ],
    expectedFragments: ['sicilian', 'c5', 'black'],
  },
];
