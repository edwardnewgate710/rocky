/**
 * Fake provider for deterministic testing.  Implements the full
 * {@link AiProvider} contract with configurable behaviour: delay,
 * failure injection, capability advertisement, and response content.
 */

import type { AiProvider } from './provider.js';
import type {
  CompletionRequest,
  CompletionResponse,
  EmbedRequest,
  EmbedResponse,
  ProviderCapabilities,
  StreamChunk,
  TokenUsage,
} from './types.js';
import { AiError } from './errors.js';

export interface FakeProviderOptions {
  readonly id: string;
  readonly displayName?: string;
  readonly capabilities?: Partial<ProviderCapabilities>;
  readonly latencyMs?: number;
  readonly content?: string;
  readonly failOnAttempt?: number; // 0-indexed; fails on this attempt
  readonly failWithError?: AiError;
  readonly model?: string;
  readonly local?: boolean;
}

export class FakeProvider implements AiProvider {
  readonly id: string;
  private readonly options: FakeProviderOptions;
  private attemptCount = 0;
  private readonly callLog: CompletionRequest[] = [];

  constructor(options: FakeProviderOptions) {
    this.id = options.id;
    this.options = options;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.callLog.push(request);
    const attempt = this.attemptCount++;
    if (this.options.failOnAttempt === attempt) {
      throw this.options.failWithError ?? new AiError(
        'provider_error',
        `Fake provider "${this.id}" injected failure on attempt ${attempt}.`,
        { retryable: true, providerId: this.id },
      );
    }
    if (this.options.latencyMs && this.options.latencyMs > 0) {
      await sleep(this.options.latencyMs, request.signal);
    }
    const content = this.options.content ?? `Response from ${this.id}`;
    const promptTokens = estimateTokens(request.messages.map((m) => m.content).join(''));
    const completionTokens = estimateTokens(content);
    const usage: TokenUsage = {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
    return {
      content,
      model: this.options.model ?? 'fake-model',
      providerId: this.id,
      usage,
      finishReason: 'stop',
      latencyMs: this.options.latencyMs ?? 10,
      costMicroUsd: 100,
      cached: false,
    };
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    this.callLog.push(request);
    const content = this.options.content ?? `Response from ${this.id}`;
    const words = content.split(' ');
    for (const word of words) {
      yield { type: 'delta', content: word + ' ' };
    }
    const promptTokens = estimateTokens(request.messages.map((m) => m.content).join(''));
    const completionTokens = estimateTokens(content);
    const usage: TokenUsage = {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
    yield {
      type: 'done',
      response: {
        content,
        model: this.options.model ?? 'fake-model',
        providerId: this.id,
        usage,
        finishReason: 'stop',
        latencyMs: this.options.latencyMs ?? 10,
        costMicroUsd: 100,
        cached: false,
      },
    };
  }

  async embed(request: EmbedRequest): Promise<EmbedResponse> {
    const attempt = this.attemptCount++;
    if (this.options.failOnAttempt === attempt) {
      throw this.options.failWithError ?? new AiError(
        'provider_error',
        `Fake provider "${this.id}" configured to fail on attempt ${attempt}.`,
        { providerId: this.id },
      );
    }
    const dim = 128;
    const embedding = Array.from({ length: dim }, (_, i) =>
      ((request.input.charCodeAt(i % request.input.length) * 31 + i) % 1000) / 1000,
    );
    return {
      embedding,
      model: 'fake-embed',
      providerId: this.id,
      usage: { promptTokens: estimateTokens(request.input), completionTokens: 0, totalTokens: 0 },
      latencyMs: 5,
      costMicroUsd: 10,
    };
  }

  async discoverCapabilities(): Promise<ProviderCapabilities> {
    return {
      providerId: this.id,
      displayName: this.options.displayName ?? this.id,
      modalities: this.options.capabilities?.modalities ?? ['text'],
      taskClasses: this.options.capabilities?.taskClasses ?? [],
      supportsStreaming: this.options.capabilities?.supportsStreaming ?? true,
      supportsStructured: this.options.capabilities?.supportsStructured ?? true,
      supportsEmbeddings: this.options.capabilities?.supportsEmbeddings ?? true,
      supportsCancellation: this.options.capabilities?.supportsCancellation ?? true,
      models: this.options.capabilities?.models ?? [
        {
          id: this.options.model ?? 'fake-model',
          displayName: this.options.model ?? 'Fake Model',
          contextWindow: 8192,
          inputCostPerMtMicroUsd: 1_000,
          outputCostPerMtMicroUsd: 2_000,
          maxOutputTokens: 4096,
        },
      ],
      maxContextTokens: this.options.capabilities?.maxContextTokens ?? 8192,
      local: this.options.capabilities?.local ?? this.options.local ?? false,
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  /** Get the log of requests received (for test assertions). */
  get calls(): readonly CompletionRequest[] {
    return this.callLog;
  }

  /** Reset the attempt counter and call log. */
  reset(): void {
    this.attemptCount = 0;
    this.callLog.length = 0;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    }, { once: true });
  });
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
