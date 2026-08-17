/**
 * Core value types for the AI orchestration layer. These are pure data —
 * no behaviour, no dependencies — shared across every seam (transport,
 * router, cache, registry, benchmark).
 */

// ---------------------------------------------------------------------------
// Task classification
// ---------------------------------------------------------------------------

/**
 * High-level task classes that the orchestrator routes by.  Each class
 * carries different latency/cost/quality expectations.  New classes are
 * added here — callers never branch on provider names.
 */
export type TaskClass =
  | 'coach'
  | 'explanation'
  | 'commentary'
  | 'puzzle_generation'
  | 'opening_explorer'
  | 'mistake_prediction'
  | 'general';

/**
 * The modality of a request.  Some providers support only text; others
 * support vision (e.g. board screenshots) or structured tool-calling.
 */
export type Modality = 'text' | 'vision' | 'tool_use';

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface SystemMessage {
  readonly role: 'system';
  readonly content: string;
}

export interface UserMessage {
  readonly role: 'user';
  readonly content: string;
}

export interface AssistantMessage {
  readonly role: 'assistant';
  readonly content: string;
}

export type Message = SystemMessage | UserMessage | AssistantMessage;

// ---------------------------------------------------------------------------
// Engine grounding context
// ---------------------------------------------------------------------------

/**
 * Structured engine facts that ground a chess-reasoning prompt.  The
 * orchestrator passes these to providers as system/user context — never
 * as provider-specific prompt templates.  Providers receive the same
 * structured data regardless of vendor.
 */
export interface EngineGrounding {
  /** FEN of the position being discussed. */
  readonly fen: string;
  /**
   * The variant these facts describe, in the platform's vocabulary (`standard`, `atomic`, …).
   *
   * Load-bearing twice over. A FEN does not carry its own rules, so without this the model is asked
   * to explain a move under rules it was never told — and in Atomic or Racing Kings the same
   * position and the same engine evaluation mean entirely different things. It is also part of
   * cache identity: {@link buildCacheKey} hashes the grounding, so two variants sharing a FEN, a
   * move and an evaluation would otherwise collide on one cached explanation.
   */
  readonly variant?: string;
  /** UCI of the move being explained (if applicable). */
  readonly moveUci?: string;
  /**
   * Evaluation of the position **after** `moveUci`, normalised to the perspective of the side that
   * played it. Positive is good for that player.
   *
   * Distinct from {@link evalCp}/{@link evalMate}, which describe the position *before* the move and
   * therefore report what the engine's own best move achieves. Without this pair a caller asking
   * "was this move good?" is handed the evaluation of a different move — the engine's preference —
   * and the difference between them is the entire answer.
   */
  readonly moveEvalCp?: number;
  /** Mate-in-N after `moveUci`, from the mover's perspective. See {@link moveEvalCp}. */
  readonly moveEvalMate?: number;
  /** Engine evaluation in centipawns from the perspective of the side to move. */
  readonly evalCp?: number;
  /** Engine evaluation as mate-in-N (positive = side to move mates). */
  readonly evalMate?: number;
  /** Best line in UCI moves from the engine. */
  readonly bestLine?: readonly string[];
  /** Legal moves map (origin square → destination squares). */
  readonly legalMoves?: ReadonlyMap<string, readonly string[]>;
  /** Depth the engine searched to. */
  readonly depth?: number;
  /** Multi-PV lines if available. */
  readonly multiPv?: readonly EnginePvLine[];
}

export interface EnginePvLine {
  readonly pv: readonly string[];
  readonly evalCp?: number;
  readonly evalMate?: number;
}

// ---------------------------------------------------------------------------
// Request / response
// ---------------------------------------------------------------------------

/**
 * A completion request.  Callers build this and hand it to the orchestrator;
 * they never know which provider will serve it.
 */
export interface CompletionRequest {
  /** Task class — drives routing, not string conditionals. */
  readonly task: TaskClass;
  /** Conversation messages (system + user + assistant turns). */
  readonly messages: readonly Message[];
  /** Requested modality. */
  readonly modality?: Modality;
  /** Engine grounding context (optional, for chess-reasoning tasks). */
  readonly grounding?: EngineGrounding;
  /** Model override (skip routing, use this specific model id). */
  readonly model?: string;
  /** Temperature (0–2, provider-clamped). */
  readonly temperature?: number;
  /** Max output tokens. */
  readonly maxTokens?: number;
  /** Latency budget in ms — providers exceeding this are deprioritised. */
  readonly latencyBudgetMs?: number;
  /** Cost ceiling in micro-dollars (1/1_000_000 USD). 0 = no ceiling. */
  readonly costCeiling?: number;
  /** User id for rate-limiting and per-user routing. */
  readonly userId?: string;
  /** Cooperative cancellation signal. */
  readonly signal?: AbortSignal;
  /** Whether streaming is requested. */
  readonly stream?: boolean;
  /** Whether a structured (JSON) response is requested. */
  readonly structured?: boolean;
  /** JSON schema for structured response validation (when structured=true). */
  readonly schema?: JsonSchema;
  /** Provider preference (soft hint, not a hard override). */
  readonly providerPreference?: string;
  /** Extra metadata for observability. */
  readonly metadata?: ReadonlyRecord<string, string>;
}

export interface CompletionResponse {
  /** The generated text. */
  readonly content: string;
  /** The model that served the request. */
  readonly model: string;
  /** The provider id that served the request. */
  readonly providerId: string;
  /** Token usage breakdown. */
  readonly usage: TokenUsage;
  /** Finish reason. */
  readonly finishReason: FinishReason;
  /** Wall-clock latency in ms. */
  readonly latencyMs: number;
  /** Estimated cost in micro-dollars. */
  readonly costMicroUsd: number;
  /** Whether this response was served from cache. */
  readonly cached: boolean;
  /** Structured response (when requested). */
  readonly structured?: unknown;
  /** Provider-specific raw response (for debugging/observability only). */
  readonly raw?: unknown;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export type FinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'tool_call'
  | 'error';

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export type StreamChunk =
  | { readonly type: 'delta'; readonly content: string }
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  | { readonly type: 'done'; readonly response: CompletionResponse }
  | { readonly type: 'error'; readonly error: Error };

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

export interface EmbedRequest {
  readonly input: string;
  readonly model?: string;
  readonly signal?: AbortSignal;
  readonly userId?: string;
}

export interface EmbedResponse {
  readonly embedding: readonly number[];
  readonly model: string;
  readonly providerId: string;
  readonly usage: TokenUsage;
  readonly latencyMs: number;
  readonly costMicroUsd: number;
}

// ---------------------------------------------------------------------------
// Provider capabilities & metadata
// ---------------------------------------------------------------------------

/**
 * Discovered capabilities of a provider.  Drives routing decisions —
 * the router checks capabilities, not provider names.
 */
export interface ProviderCapabilities {
  readonly providerId: string;
  readonly displayName: string;
  /** Supported modalities. */
  readonly modalities: readonly Modality[];
  /** Supported task classes (empty = all). */
  readonly taskClasses: readonly TaskClass[];
  /** Whether streaming is supported. */
  readonly supportsStreaming: boolean;
  /** Whether structured/JSON responses are supported. */
  readonly supportsStructured: boolean;
  /** Whether embeddings are supported. */
  readonly supportsEmbeddings: boolean;
  /** Whether cancellation is supported (AbortSignal). */
  readonly supportsCancellation: boolean;
  /** Available models with metadata. */
  readonly models: readonly ModelInfo[];
  /** Maximum context window in tokens. */
  readonly maxContextTokens: number;
  /** Whether the provider is local (e.g. Ollama). */
  readonly local: boolean;
}

export interface ModelInfo {
  readonly id: string;
  readonly displayName: string;
  /** Context window in tokens. */
  readonly contextWindow: number;
  /** Input cost per 1M tokens in micro-dollars. */
  readonly inputCostPerMtMicroUsd: number;
  /** Output cost per 1M tokens in micro-dollars. */
  readonly outputCostPerMtMicroUsd: number;
  /** Max output tokens. */
  readonly maxOutputTokens: number;
  /** Supported modalities for this specific model. */
  readonly modalities?: readonly Modality[];
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type HealthState = 'healthy' | 'degraded' | 'unhealthy';

export interface ProviderHealth {
  readonly providerId: string;
  readonly state: HealthState;
  /** Average latency in ms over the recent window. */
  readonly avgLatencyMs: number;
  /** Success rate (0–1) over the recent window. */
  readonly successRate: number;
  /** Number of requests in the recent window. */
  readonly requestCount: number;
  /** Number of consecutive failures. */
  readonly consecutiveFailures: number;
  /** Whether the provider is currently circuit-broken. */
  readonly circuitOpen: boolean;
  /** Last error message (if any). */
  readonly lastError?: string;
  /** Timestamp of last successful request. */
  readonly lastSuccessMs?: number;
}

export interface OrchestratorHealth {
  readonly providers: readonly ProviderHealth[];
  readonly totalRequests: number;
  readonly totalCacheHits: number;
  readonly totalFailovers: number;
}

// ---------------------------------------------------------------------------
// JSON schema (minimal, for structured responses)
// ---------------------------------------------------------------------------

export interface JsonSchema {
  readonly type?: string;
  readonly properties?: ReadonlyRecord<string, unknown>;
  readonly required?: readonly string[];
  readonly items?: unknown;
  readonly additionalProperties?: boolean;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export type ReadonlyRecord<K extends string, V> = {
  readonly [key in K]: V;
};
