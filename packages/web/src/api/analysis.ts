/**
 * Engine analysis REST API surface (M15 inc 2).
 */
import type { Execute } from './client.js';
import type { AnalysisResponse, AnalyzeRequest } from './models.js';

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
}
