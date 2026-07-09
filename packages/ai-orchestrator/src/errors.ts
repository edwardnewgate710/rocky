/**
 * Typed error hierarchy for the AI orchestration layer.  Every error
 * carries a stable, machine-readable `code` so callers (and the router)
 * can branch on failure kind without string-matching messages.
 * `retryable` marks failures that the router may safely retry on
 * another provider.
 */

export type AiErrorCode =
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'provider_error'
  | 'rate_limited'
  | 'auth_failed'
  | 'invalid_response'
  | 'context_too_long'
  | 'content_filtered'
  | 'no_provider'
  | 'circuit_open'
  | 'cancelled'
  | 'budget_exceeded'
  | 'schema_validation'
  | 'config_error';

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly retryable: boolean;
  readonly providerId?: string;

  constructor(
    code: AiErrorCode,
    message: string,
    options?: { retryable?: boolean; cause?: unknown; providerId?: string },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.providerId = options?.providerId;
  }
}

export class ProviderUnavailableError extends AiError {
  constructor(providerId: string, message: string, cause?: unknown) {
    super('provider_unavailable', message, { retryable: true, cause, providerId });
  }
}

export class ProviderTimeoutError extends AiError {
  constructor(providerId: string, timeoutMs: number) {
    super(
      'provider_timeout',
      `Provider "${providerId}" timed out after ${timeoutMs}ms.`,
      { retryable: true, providerId },
    );
  }
}

export class ProviderError extends AiError {
  constructor(providerId: string, message: string, cause?: unknown) {
    super('provider_error', message, { retryable: true, cause, providerId });
  }
}

export class RateLimitedError extends AiError {
  constructor(providerId: string, retryAfterMs?: number) {
    super(
      'rate_limited',
      `Provider "${providerId}" rate-limited the request${retryAfterMs !== undefined ? ` (retry after ${retryAfterMs}ms)` : ''}.`,
      { retryable: true, providerId },
    );
  }
}

export class AuthFailedError extends AiError {
  constructor(providerId: string, message: string) {
    super('auth_failed', `Auth failed for "${providerId}": ${message}`, { providerId });
  }
}

export class InvalidResponseError extends AiError {
  constructor(providerId: string, message: string) {
    super('invalid_response', `Invalid response from "${providerId}": ${message}`, { providerId });
  }
}

export class ContextTooLongError extends AiError {
  constructor(providerId: string, tokens: number, max: number) {
    super(
      'context_too_long',
      `Context (${tokens} tokens) exceeds "${providerId}" max (${max}).`,
      { providerId },
    );
  }
}

export class ContentFilteredError extends AiError {
  constructor(providerId: string, message: string) {
    super('content_filtered', `Content filtered by "${providerId}": ${message}`, { providerId });
  }
}

export class NoProviderError extends AiError {
  constructor(message: string) {
    super('no_provider', message);
  }
}

export class CircuitOpenError extends AiError {
  constructor(providerId: string) {
    super(
      'circuit_open',
      `Circuit breaker open for "${providerId}".`,
      { retryable: true, providerId },
    );
  }
}

export class CancelledError extends AiError {
  constructor(message = 'Operation cancelled.') {
    super('cancelled', message);
  }
}

export class BudgetExceededError extends AiError {
  constructor(message: string) {
    super('budget_exceeded', message);
  }
}

export class SchemaValidationError extends AiError {
  constructor(providerId: string, message: string) {
    super('schema_validation', `Schema validation failed for "${providerId}": ${message}`, { providerId });
  }
}

export class ConfigError extends AiError {
  constructor(message: string) {
    super('config_error', message);
  }
}
