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
  OpeningExplorationRequest,
  OpeningExplorationResponse,
  EndgameNextRequest,
  EndgamePosition,
  EndgameAttemptRequest,
  EndgameAttemptResult,
  CoachRequest,
  CoachResponse,
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

  /**
   * Identify the opening for a move sequence read from the standard starting position (M15 inc 19).
   *
   * POST /v1/openings/explore, auth: true. No engine is involved on the server side, so unlike
   * {@link analyse} this costs no worker — but it is still not retried, because a repeat would only
   * ask a deterministic table the same question twice.
   *
   * Sends only `variant`, `moves` and (when supplied) `initialFen`; the server rejects any other
   * property, so the body is built field by field rather than spread.
   */
  exploreOpening(
    body: OpeningExplorationRequest,
    signal?: AbortSignal,
  ): Promise<OpeningExplorationResponse> {
    return this.execute<OpeningExplorationResponse>({
      method: 'POST',
      path: '/v1/openings/explore',
      body: {
        variant: body.variant,
        moves: [...body.moves],
        ...(body.initialFen === undefined ? {} : { initialFen: body.initialFen }),
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

  /**
   * Fetch the next endgame training position (M15 inc 20).
   *
   * POST /v1/endgames/next, auth: true.
   *
   * Sends only `type`, `difficulty`, and `id` when provided. Built field by field
   * rather than spread — the server refuses unknown properties. No retry.
   */
  nextEndgame(
    body: EndgameNextRequest = {},
    signal?: AbortSignal,
  ): Promise<EndgamePosition> {
    return this.execute<EndgamePosition>({
      method: 'POST',
      path: '/v1/endgames/next',
      body: {
        ...(body.type !== undefined ? { type: body.type } : {}),
        ...(body.difficulty !== undefined ? { difficulty: body.difficulty } : {}),
        ...(body.id !== undefined ? { id: body.id } : {}),
      },
      auth: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /**
   * Submit an attempt for the current endgame position (M15 inc 20).
   *
   * POST /v1/endgames/attempt, auth: true.
   *
   * Sends only `id` and `move` field by field. No retry.
   */
  attemptEndgame(
    body: EndgameAttemptRequest,
    signal?: AbortSignal,
  ): Promise<EndgameAttemptResult> {
    return this.execute<EndgameAttemptResult>({
      method: 'POST',
      path: '/v1/endgames/attempt',
      body: {
        id: body.id,
        move: body.move,
      },
      auth: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /**
   * Coach a position across every feature the server composes (M15 inc 21, ADR-0129).
   *
   * POST /v1/coach, auth: true.
   *
   * Sends `fen`, `variant`, and optionally `move` and `moves` — field by field, and nothing else.
   * There is deliberately no depth, multiPv, movetime, nodes, threshold, provider, model,
   * temperature or maxTokens: each is server-owned policy, and the endpoint refuses a body carrying
   * one rather than ignoring it, so sending any of them would fail the whole request.
   *
   * No retry. One accepted call can cost the server four engine searches and a provider call, so a
   * client that retried on its own would multiply the most expensive request in the API.
   */
  coach(body: CoachRequest, signal?: AbortSignal): Promise<CoachResponse> {
    return this.execute<CoachResponse>({
      method: 'POST',
      path: '/v1/coach',
      body: {
        fen: body.fen,
        variant: body.variant,
        ...(body.move !== undefined ? { move: body.move } : {}),
        ...(body.moves !== undefined ? { moves: [...body.moves] } : {}),
      },
      auth: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }
}

