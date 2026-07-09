/**
 * OpenAI-compatible HTTP adapter.  A single adapter covers OpenAI,
 * DeepSeek, OpenRouter, and Ollama via configurable `baseUrl`.
 *
 * Uses the global `fetch` (Node 22+).  No SDK dependency — the adapter
 * talks directly to the REST API, keeping the domain dependency-free.
 */

import type {
  CompletionRequest,
  CompletionResponse,
  EmbedRequest,
  EmbedResponse,
  ProviderCapabilities,
  StreamChunk,
  TokenUsage,
  FinishReason,
} from './types.js';
import type { AiProvider } from './provider.js';
import {
  AiError,
  AuthFailedError,
  InvalidResponseError,
  RateLimitedError,
  ContextTooLongError,
  ContentFilteredError,
} from './errors.js';

export interface OpenAiCompatibleOptions {
  /** Provider id (e.g. "openai", "deepseek", "openrouter", "ollama"). */
  readonly id: string;
  /** Display name for capability reporting. */
  readonly displayName?: string;
  /** API key (from environment, never hardcoded). */
  readonly apiKey?: string;
  /** Base URL (default: "https://api.openai.com/v1"). */
  readonly baseUrl?: string;
  /** Default model. */
  readonly defaultModel?: string;
  /** Whether the provider is local (e.g. Ollama). */
  readonly local?: boolean;
  /** Available models (static list; if omitted, discovered via API). */
  readonly models?: readonly { readonly id: string; readonly displayName?: string; readonly contextWindow?: number; readonly inputCostPerMtMicroUsd?: number; readonly outputCostPerMtMicroUsd?: number; readonly maxOutputTokens?: number }[];
}

/** Default base URLs per provider id. */
const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://localhost:11434/v1',
};

export class OpenAiCompatibleAdapter implements AiProvider {
  readonly id: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly displayName: string;
  private readonly local: boolean;
  private readonly staticModels: OpenAiCompatibleOptions['models'];

  constructor(options: OpenAiCompatibleOptions) {
    this.id = options.id;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URLS[options.id] ?? 'https://api.openai.com/v1';
    this.defaultModel = options.defaultModel ?? 'gpt-4o-mini';
    this.displayName = options.displayName ?? options.id;
    this.local = options.local ?? false;
    this.staticModels = options.models;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const model = request.model ?? this.defaultModel;
    const body = this.buildRequestBody(request, model, false);
    const start = Date.now();

    const resp = await this.fetchWithAuth(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: request.signal,
    });

    await this.checkResponse(resp);

    const json = await resp.json() as OpenAiChatResponse;
    const latencyMs = Date.now() - start;

    return {
      content: json.choices[0]?.message?.content ?? '',
      model: json.model ?? model,
      providerId: this.id,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        totalTokens: json.usage?.total_tokens ?? 0,
      },
      finishReason: this.mapFinishReason(json.choices[0]?.finish_reason),
      latencyMs,
      costMicroUsd: this.estimateCost(model, json.usage),
      cached: false,
    };
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const model = request.model ?? this.defaultModel;
    const body = this.buildRequestBody(request, model, true);

    const resp = await this.fetchWithAuth(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: request.signal,
    });

    await this.checkResponse(resp);

    const reader = resp.body?.getReader();
    if (!reader) throw new InvalidResponseError(this.id, 'No response body for streaming.');

    const decoder = new TextDecoder();
    let buffer = '';
    let totalContent = '';
    let usage: TokenUsage | undefined;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;
        try {
          const chunk = JSON.parse(data) as OpenAiStreamChunk;
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            totalContent += delta;
            yield { type: 'delta', content: delta };
          }
          if (chunk.usage) {
            usage = {
              promptTokens: chunk.usage.prompt_tokens ?? 0,
              completionTokens: chunk.usage.completion_tokens ?? 0,
              totalTokens: chunk.usage.total_tokens ?? 0,
            };
          }
        } catch {
          // Skip malformed chunks.
        }
      }
    }

    yield {
      type: 'done',
      response: {
        content: totalContent,
        model,
        providerId: this.id,
        usage: usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: 'stop',
        latencyMs: 0,
        costMicroUsd: 0,
        cached: false,
      },
    };
  }

  async embed(request: EmbedRequest): Promise<EmbedResponse> {
    const model = request.model ?? 'text-embedding-3-small';
    const start = Date.now();

    const resp = await this.fetchWithAuth(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model, input: request.input }),
      signal: request.signal,
    });

    await this.checkResponse(resp);

    const json = await resp.json() as OpenAiEmbedResponse;
    const latencyMs = Date.now() - start;

    return {
      embedding: json.data[0]?.embedding ?? [],
      model,
      providerId: this.id,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: 0,
        totalTokens: json.usage?.prompt_tokens ?? 0,
      },
      latencyMs,
      costMicroUsd: 0,
    };
  }

  async discoverCapabilities(): Promise<ProviderCapabilities> {
    let models;
    if (this.staticModels) {
      models = this.staticModels.map(m => ({
        id: m.id,
        displayName: m.displayName ?? m.id,
        contextWindow: m.contextWindow ?? 8192,
        inputCostPerMtMicroUsd: m.inputCostPerMtMicroUsd ?? 0,
        outputCostPerMtMicroUsd: m.outputCostPerMtMicroUsd ?? 0,
        maxOutputTokens: m.maxOutputTokens ?? 4096,
      }));
    } else {
      try {
        models = await this.listModels();
      } catch {
        models = [{
          id: this.defaultModel,
          displayName: this.defaultModel,
          contextWindow: 8192,
          inputCostPerMtMicroUsd: 0,
          outputCostPerMtMicroUsd: 0,
          maxOutputTokens: 4096,
        }];
      }
    }

    return {
      providerId: this.id,
      displayName: this.displayName,
      modalities: ['text'],
      taskClasses: [],
      supportsStreaming: true,
      supportsStructured: true,
      supportsEmbeddings: true,
      supportsCancellation: true,
      models,
      maxContextTokens: models[0]?.contextWindow ?? 8192,
      local: this.local,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await this.fetchWithAuth(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.headers(),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      h['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  private buildRequestBody(request: CompletionRequest, model: string, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map(m => ({ role: m.role, content: m.content })),
      stream,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.structured && request.schema) {
      body.response_format = { type: 'json_object' };
    }
    return body;
  }

  private async fetchWithAuth(url: string, init: RequestInit): Promise<Response> {
    if (typeof fetch === 'undefined') {
      throw new AiError('provider_unavailable', 'fetch is not available in this environment.', { providerId: this.id });
    }
    return fetch(url, init);
  }

  private async checkResponse(resp: Response): Promise<void> {
    if (resp.ok) return;
    let errorMessage = '';
    try {
      const errorBody = await resp.json() as { error?: { message?: string; type?: string; code?: string } };
      errorMessage = errorBody.error?.message ?? '';
    } catch {
      errorMessage = `HTTP ${resp.status}`;
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new AuthFailedError(this.id, errorMessage);
    }
    if (resp.status === 429) {
      throw new RateLimitedError(this.id);
    }
    if (resp.status === 400 && errorMessage.includes('context')) {
      throw new ContextTooLongError(this.id, 0, 0);
    }
    if (resp.status === 400 && (errorMessage.includes('content_filter') || errorMessage.includes('content policy'))) {
      throw new ContentFilteredError(this.id, errorMessage);
    }
    throw new AiError('provider_error', errorMessage, { retryable: true, providerId: this.id });
  }

  private mapFinishReason(reason: string | undefined): FinishReason {
    switch (reason) {
      case 'stop': return 'stop';
      case 'length': return 'length';
      case 'content_filter': return 'content_filter';
      case 'tool_calls': return 'tool_call';
      default: return 'stop';
    }
  }

  private estimateCost(_model: string, _usage: { prompt_tokens?: number; completion_tokens?: number } | undefined): number {
    // Cost estimation: look up model in capabilities and compute.
    // For now, return 0 — real cost tracking requires a pricing table.
    return 0;
  }

  private async listModels(): Promise<readonly { id: string; displayName: string; contextWindow: number; inputCostPerMtMicroUsd: number; outputCostPerMtMicroUsd: number; maxOutputTokens: number }[]> {
    const resp = await this.fetchWithAuth(`${this.baseUrl}/models`, {
      method: 'GET',
      headers: this.headers(),
    });
    if (!resp.ok) throw new AiError('provider_error', 'Failed to list models.', { providerId: this.id });
    const json = await resp.json() as { data: { id: string }[] };
    return json.data.map(m => ({
      id: m.id,
      displayName: m.id,
      contextWindow: 8192,
      inputCostPerMtMicroUsd: 0,
      outputCostPerMtMicroUsd: 0,
      maxOutputTokens: 4096,
    }));
  }
}

// ---------------------------------------------------------------------------
// Response types (minimal, matching the OpenAI API spec)
// ---------------------------------------------------------------------------

interface OpenAiChatResponse {
  readonly id: string;
  readonly model: string;
  readonly choices: readonly {
    readonly message: { readonly role: string; readonly content: string };
    readonly finish_reason: string;
  }[];
  readonly usage?: { readonly prompt_tokens: number; readonly completion_tokens: number; readonly total_tokens: number };
}

interface OpenAiStreamChunk {
  readonly choices?: readonly {
    readonly delta: { readonly content?: string };
    readonly finish_reason?: string;
  }[];
  readonly usage?: { readonly prompt_tokens: number; readonly completion_tokens: number; readonly total_tokens: number };
}

interface OpenAiEmbedResponse {
  readonly data: readonly { readonly embedding: readonly number[]; readonly index: number }[];
  readonly usage?: { readonly prompt_tokens: number; readonly total_tokens: number };
}
