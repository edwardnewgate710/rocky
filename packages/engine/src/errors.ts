/**
 * Typed error hierarchy for the engine bridge. Every error carries a stable
 * machine-readable `code` so callers (and the AI orchestrator in M7) can branch on
 * failure kind without string-matching messages. `retryable` marks failures that a
 * scheduler may safely retry on another worker (e.g. a crash mid-analysis).
 */

export type EngineErrorCode =
  | 'invalid_fen'
  | 'no_engine_for_variant'
  | 'engine_crashed'
  | 'engine_timeout'
  | 'engine_version'
  | 'protocol'
  | 'queue_full'
  | 'circuit_open'
  | 'cancelled'
  | 'shutting_down'
  | 'not_initialized';

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly retryable: boolean;

  constructor(code: EngineErrorCode, message: string, options?: { retryable?: boolean; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.retryable = options?.retryable ?? false;
  }
}

export class InvalidFenError extends EngineError {
  constructor(message: string) {
    super('invalid_fen', message);
  }
}

export class NoEngineForVariantError extends EngineError {
  constructor(variant: string) {
    super('no_engine_for_variant', `No registered engine supports variant "${variant}".`);
  }
}

export class EngineCrashError extends EngineError {
  constructor(message: string, cause?: unknown) {
    super('engine_crashed', message, { retryable: true, cause });
  }
}

export class EngineTimeoutError extends EngineError {
  constructor(message: string) {
    super('engine_timeout', message, { retryable: true });
  }
}

export class EngineVersionError extends EngineError {
  constructor(message: string) {
    super('engine_version', message);
  }
}

export class ProtocolError extends EngineError {
  constructor(message: string) {
    super('protocol', message);
  }
}

export class QueueFullError extends EngineError {
  constructor(message: string) {
    super('queue_full', message, { retryable: true });
  }
}

export class CircuitOpenError extends EngineError {
  constructor(message: string) {
    super('circuit_open', message, { retryable: true });
  }
}

export class CancelledError extends EngineError {
  constructor(message = 'Operation cancelled.') {
    super('cancelled', message);
  }
}

export class ShuttingDownError extends EngineError {
  constructor(message = 'Engine manager is shutting down.') {
    super('shutting_down', message);
  }
}
