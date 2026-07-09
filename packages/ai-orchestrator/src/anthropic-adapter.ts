/**
 * Anthropic HTTP adapter.  Uses the Anthropic Messages API.
 *
 * Uses the global `fetch` (Node 22+).  No SDK dependency.
 */

import type {
  CompletionRequest,
  CompletionResponse,
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
} from './errors.js';

export interface AnthropicAdapterOptions {
  /** API key (from environment, never hardcoded). */
  readonly apiKey?: string;
  /** Base URL (default: "https://api.anthropic.com"). */
  readonly baseUrl?: string;
  /** Default model. */
  readonly defaultModel?: string;
  /** Anthropic API version header. */
  readonly anthropicVersion?: string;
}

export class AnthropicAdapter implements AiProvider {
  readonly id = 'anthropic';
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly anthropicVersion: string;

  constructor(options: AnthropicAdapterOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? 'https://api.anthropic.com';
    this.defaultModel = options.defaultModel ?? 'claude-3-5-sonnet-20241022';
    this.anthropicVersion = options.anthropicVersion ?? '2023-06-01';
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const model = request.model ?? this.defaultModel;
    const { system, messages } = this.convertMessages(request.messages);
    const body: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? 1024,
      messages,
    };
    if (system) body.system = system;
    if (request.temperature !== undefined) body.temperature = request.temperature;

    const start = Date.now();
    const resp = await this.fetchWithAuth(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: request.signal,
    });

    await this.checkResponse(resp);

    const json = await resp.json() as AnthropicResponse;
    const latencyMs = Date.now() - start;
    const content = json.content.map(b => b.text).join('');

    return {
      content,
      model: json.model ?? model,
      providerId: this.id,
      usage: {
        promptTokens: json.usage?.input_tokens ?? 0,
        completionTokens: json.usage?.output_tokens ?? 0,
        totalTokens: (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0),
      },
      finishReason: this.mapFinishReason(json.stop_reason),
      latencyMs,
      costMicroUsd: 0,
      cached: false,
    };
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const model = request.model ?? this.defaultModel;
    const { system, messages } = this.convertMessages(request.messages);
    const body: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? 1024,
      messages,
      stream: true,
    };
    if (system) body.system = system;
    if (request.temperature !== undefined) body.temperature = request.temperature;

    const resp = await this.fetchWithAuth(`${this.baseUrl}/v1/messages`, {
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
        try {
          const event = JSON.parse(data) as AnthropicStreamEvent;
          if (event.type === 'content_block_delta' && event.delta?.text) {
            totalContent += event.delta.text;
            yield { type: 'delta', content: event.delta.text };
          }
          if (event.type === 'message_delta' && event.usage) {
            usage = {
              promptTokens: event.usage.input_tokens ?? 0,
              completionTokens: event.usage.output_tokens ?? 0,
              totalTokens: (event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0),
            };
          }
        } catch {
          // Skip malformed events.
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

  async embed(_request: import('./types.js').EmbedRequest): Promise<import('./types.js').EmbedResponse> {
    throw new AiError('provider_error', 'Anthropic does not support embeddings.', { providerId: this.id });
  }

  async discoverCapabilities(): Promise<ProviderCapabilities> {
    return {
      providerId: this.id,
      displayName: 'Anthropic',
      modalities: ['text', 'vision'],
      taskClasses: [],
      supportsStreaming: true,
      supportsStructured: true,
      supportsEmbeddings: false,
      supportsCancellation: true,
      models: [
        {
          id: this.defaultModel,
          displayName: this.defaultModel,
          contextWindow: 200_000,
          inputCostPerMtMicroUsd: 3_000,
          outputCostPerMtMicroUsd: 15_000,
          maxOutputTokens: 8192,
        },
      ],
      maxContextTokens: 200_000,
      local: false,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Anthropic doesn't have a /models endpoint; use a minimal request.
      const resp = await this.fetchWithAuth(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: this.defaultModel,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      return resp.ok || resp.status === 400; // 400 = valid auth, bad request
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': this.anthropicVersion,
    };
    if (this.apiKey) {
      h['x-api-key'] = this.apiKey;
    }
    return h;
  }

  private convertMessages(messages: readonly { role: string; content: string }[]): {
    system: string | undefined;
    messages: { role: string; content: string }[];
  } {
    const systemParts: string[] = [];
    const converted: { role: string; content: string }[] = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        systemParts.push(msg.content);
      } else {
        converted.push({ role: msg.role, content: msg.content });
      }
    }
    return {
      system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
      messages: converted,
    };
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
      const errorBody = await resp.json() as { error?: { message?: string; type?: string } };
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
    throw new AiError('provider_error', errorMessage, { retryable: true, providerId: this.id });
  }

  private mapFinishReason(reason: string | undefined): FinishReason {
    switch (reason) {
      case 'end_turn': return 'stop';
      case 'max_tokens': return 'length';
      case 'stop_sequence': return 'stop';
      default: return 'stop';
    }
  }
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

interface AnthropicResponse {
  readonly model: string;
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly stop_reason: string;
  readonly usage?: { readonly input_tokens: number; readonly output_tokens: number };
}

interface AnthropicStreamEvent {
  readonly type: string;
  readonly delta?: { readonly text?: string };
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
}
