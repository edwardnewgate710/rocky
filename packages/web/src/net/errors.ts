/**
 * Networking error taxonomy.
 *
 * Every failure surfaced by the API client is a subclass of {@link ApiError}, so
 * callers branch on `instanceof` (or the discriminant `kind`) instead of
 * sniffing raw status codes. Transport failures become {@link NetworkError} /
 * {@link TimeoutError} / {@link RequestAbortedError}; non-2xx responses become an
 * {@link HttpError} (or a status-specific subclass) that preserves the server
 * error envelope — importantly `requestId` — for support and log correlation.
 *
 * `retryable` is a *hint* that the failure class is transient; the retry policy
 * (which also knows whether the HTTP method is safe to repeat) has the final say.
 */
import type { ApiErrorEnvelope } from '../api/models.js';

export type ApiErrorKind = 'network' | 'timeout' | 'aborted' | 'decode' | 'http';

export abstract class ApiError extends Error {
  abstract readonly kind: ApiErrorKind;
  /** HTTP status; 0 when the failure occurred below the HTTP layer. */
  readonly status: number;
  /** Hint that this failure class is transiently retryable. */
  readonly retryable: boolean;

  protected constructor(message: string, status: number, retryable: boolean, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = new.target.name;
    this.status = status;
    this.retryable = retryable;
  }
}

/** Transport failed before any response (offline, DNS, connection reset). */
export class NetworkError extends ApiError {
  readonly kind = 'network';
  constructor(message = 'network request failed', cause?: unknown) {
    super(message, 0, true, cause);
  }
}

/** The client aborted the request because it exceeded its timeout budget. */
export class TimeoutError extends ApiError {
  readonly kind = 'timeout';
  readonly timeoutMs: number;
  constructor(timeoutMs: number, cause?: unknown) {
    super(`request timed out after ${timeoutMs}ms`, 0, true, cause);
    this.timeoutMs = timeoutMs;
  }
}

/** The caller aborted the request via their own signal. Never auto-retried. */
export class RequestAbortedError extends ApiError {
  readonly kind = 'aborted';
  constructor(message = 'request aborted', cause?: unknown) {
    super(message, 0, false, cause);
  }
}

/** A 2xx response whose body could not be parsed/decoded as expected. */
export class DecodeError extends ApiError {
  readonly kind = 'decode';
  constructor(message: string, status: number, cause?: unknown) {
    super(message, status, false, cause);
  }
}

export interface HttpErrorParams {
  readonly status: number;
  readonly message: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId?: string | undefined;
  readonly details?: Record<string, unknown> | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly cause?: unknown;
}

/** A non-2xx HTTP response. Status-specific subclasses extend this. */
export class HttpError extends ApiError {
  readonly kind = 'http';
  /** Machine-readable server error code (from the envelope, or a synthesized default). */
  readonly code: string;
  readonly requestId: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  /** Suggested delay before retrying, derived from a `Retry-After` header. */
  readonly retryAfterMs: number | undefined;

  constructor(params: HttpErrorParams) {
    super(params.message, params.status, params.retryable, params.cause);
    this.code = params.code;
    this.requestId = params.requestId;
    this.details = params.details;
    this.retryAfterMs = params.retryAfterMs;
  }
}

export class BadRequestError extends HttpError {} // 400
export class UnauthorizedError extends HttpError {} // 401
export class ForbiddenError extends HttpError {} // 403
export class NotFoundError extends HttpError {} // 404
export class ConflictError extends HttpError {} // 409
export class ValidationError extends HttpError {} // 422
export class RateLimitError extends HttpError {} // 429
export class ServerError extends HttpError {} // 5xx
/**
 * 503 specifically. Split out of {@link ServerError} because callers act on the two differently: a
 * 500 is a fault worth surfacing, while a 503 is how the API reports an optional subsystem this
 * deployment did not configure (the `ApiDependencies` fields in `packages/api` — achievements,
 * search, messaging, …). Extends `ServerError` so an existing `instanceof ServerError` branch keeps
 * catching it.
 */
export class ServiceUnavailableError extends ServerError {} // 503

const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/** Whether a status code is transiently retryable (server overloaded/unavailable). */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

function defaultCode(status: number): string {
  if (status >= 500) return 'server_error';
  if (status === 429) return 'rate_limited';
  if (status === 404) return 'not_found';
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 409) return 'conflict';
  if (status === 422) return 'unprocessable';
  if (status === 400) return 'bad_request';
  return 'http_error';
}

function defaultMessage(status: number): string {
  return `HTTP ${status}`;
}

/**
 * Build the appropriate {@link HttpError} subclass for a status code, folding in
 * a parsed server error envelope when present.
 */
export function httpErrorFrom(
  status: number,
  envelope: ApiErrorEnvelope | undefined,
  opts: { retryAfterMs?: number | undefined; cause?: unknown } = {},
): HttpError {
  const params: HttpErrorParams = {
    status,
    message: envelope?.error.message ?? defaultMessage(status),
    code: envelope?.error.code ?? defaultCode(status),
    retryable: isRetryableStatus(status),
    requestId: envelope?.error.requestId,
    details: envelope?.error.details,
    retryAfterMs: opts.retryAfterMs,
    cause: opts.cause,
  };
  switch (status) {
    case 400:
      return new BadRequestError(params);
    case 401:
      return new UnauthorizedError(params);
    case 403:
      return new ForbiddenError(params);
    case 404:
      return new NotFoundError(params);
    case 409:
      return new ConflictError(params);
    case 422:
      return new ValidationError(params);
    case 429:
      return new RateLimitError(params);
    case 503:
      return new ServiceUnavailableError(params);
    default:
      return status >= 500 ? new ServerError(params) : new HttpError(params);
  }
}

/**
 * Parse a `Retry-After` header value into milliseconds. Supports the
 * delta-seconds form (the common case); the HTTP-date form is ignored (returns
 * undefined) so the caller falls back to computed backoff.
 */
export function parseRetryAfterMs(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  return undefined;
}
