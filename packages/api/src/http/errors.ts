/**
 * @packageDocumentation
 * The HTTP error hierarchy. Services and routes throw these; the router
 * translates them into a stable JSON error envelope with the right status code.
 * Anything that is not an {@link HttpError} is treated as an internal error and
 * never leaks its message to the client.
 */

/** A machine-readable error code returned to clients in the error envelope. */
export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'internal';

/**
 * An error carrying an HTTP status, a stable machine code, and (optionally)
 * structured details for validation failures. Only {@link HttpError} messages are
 * surfaced to clients.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
    readonly headers?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  static badRequest(message: string, details?: Record<string, unknown>): HttpError {
    return new HttpError(400, 'bad_request', message, details);
  }

  static validation(message: string, details?: Record<string, unknown>): HttpError {
    return new HttpError(422, 'validation_failed', message, details);
  }

  static unauthorized(message = 'authentication required'): HttpError {
    return new HttpError(401, 'unauthorized', message);
  }

  static forbidden(message = 'insufficient permissions'): HttpError {
    return new HttpError(403, 'forbidden', message);
  }

  static notFound(message = 'resource not found'): HttpError {
    return new HttpError(404, 'not_found', message);
  }

  static conflict(message: string, details?: Record<string, unknown>): HttpError {
    return new HttpError(409, 'conflict', message, details);
  }

  static rateLimited(retryAfterSeconds: number, message = 'too many requests'): HttpError {
    return new HttpError(429, 'rate_limited', message, undefined, {
      'Retry-After': String(retryAfterSeconds),
    });
  }
}
