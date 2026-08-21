/**
 * Engine analysis REST API surface (M15 inc 2).
 */
import type { Execute } from './client.js';
import type {
  AnalysisResponse,
  AnalyzeRequest,
  MoveExplanationRequest,
  MoveExplanationResponse,
  MistakePredictionRequest,
  MistakePredictionResponse,
  PuzzleGenerationRequest,
  PuzzleGenerationResponse,
} from './models.js';

export class AnalysisApi {
  private readonly execute: Execute;

  constructor(execute: Execute) {
    this.execute = execute;
  }

  /**
   * Request engine analysis of a position.
   *
   * POST /v1/analysis, auth: true.
   *
   * Note on retries: do NOT set idempotent true. An analysis request occupies an engine worker
   * and the server cannot observe a client disconnect (ADR-0113), so a retry doubles real engine
   * load.
   */
  analyse(body: AnalyzeRequest, signal?: AbortSignal): Promise<AnalysisResponse> {
    return this.execute<AnalysisResponse>({
      method: 'POST',
      path: '/v1/analysis',
      body,
      auth: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /**
   * Request an engine-grounded explanation of a move (M15 inc 4).
   *
   * POST /v1/ai/move-explanation, auth: true.
   *
   * Sends only `fen`, `variant`, `move` — the server rejects any other property.
   * No retry logic. No caching.
   */
  explainMove(
    body: MoveExplanationRequest,
    signal?: AbortSignal,
  ): Promise<MoveExplanationResponse> {
    return this.execute<MoveExplanationResponse>({
      method: 'POST',
      path: '/v1/ai/move-explanation',
      body: {
        fen: body.fen,
        variant: body.variant,
        move: body.move,
      },
      auth: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /**
   * Request an engine-grounded mistake prediction for a move (M15 inc 5).
   *
   * POST /v1/analysis/mistake-prediction, auth: true.
   *
   * Sends only `fen`, `variant`, `move` — the server rejects any other property.
   * No retry logic. No caching.
   */
  predictMistake(
    body: MistakePredictionRequest,
    signal?: AbortSignal,
  ): Promise<MistakePredictionResponse> {
    return this.execute<MistakePredictionResponse>({
      method: 'POST',
      path: '/v1/analysis/mistake-prediction',
      body: {
        fen: body.fen,
        variant: body.variant,
        move: body.move,
      },
      auth: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /** One non-retried, fixed-policy tactic search. */
  findPuzzle(
    body: PuzzleGenerationRequest,
    signal?: AbortSignal,
  ): Promise<PuzzleGenerationResponse> {
    return this.execute<PuzzleGenerationResponse>({
      method: 'POST',
      path: '/v1/analysis/puzzle',
      body: { fen: body.fen, variant: body.variant },
      auth: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }
}

