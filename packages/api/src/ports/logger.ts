/**
 * @packageDocumentation
 * Structured logging port (M13 observability). Dependency-free: `JsonLogger`
 * emits one JSON object per line to stdout; `NullLogger` is the silent test
 * default. `child(bindings)` returns a logger that merges the bindings into
 * every record, so a per-request logger can carry `{ requestId, traceId, … }`.
 *
 * Never pass secrets or PII as fields — tokens, passwords, refresh tokens,
 * emails, or raw request bodies must never reach a log record.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** A JSON-serializable primitive acceptable as a structured log field. */
export type LogValue = string | number | boolean | null;

export type LogFields = Readonly<Record<string, LogValue>>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that merges `bindings` into every record it (and its children) emit. */
  child(bindings: LogFields): Logger;
}

/** Sink seam so tests can capture output; defaults to stdout. */
export type LogSink = (line: string) => void;

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface JsonLoggerOptions {
  /** Minimum level to emit (default 'info'). */
  readonly level?: LogLevel;
  /** Where to write serialized lines (default stdout). */
  readonly sink?: LogSink;
}

/** Structured JSON logger: one object per line, ISO timestamp, level, msg + fields. */
export class JsonLogger implements Logger {
  private readonly bindings: LogFields;
  private readonly minRank: number;
  private readonly sink: LogSink;

  constructor(bindings: LogFields = {}, options: JsonLoggerOptions = {}) {
    this.bindings = bindings;
    this.minRank = LEVEL_RANK[options.level ?? 'info'];
    this.sink = options.sink ?? ((line) => process.stdout.write(line + '\n'));
  }

  private emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < this.minRank) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...this.bindings,
      ...(fields ?? {}),
    };
    this.sink(JSON.stringify(record));
  }

  debug(msg: string, fields?: LogFields): void { this.emit('debug', msg, fields); }
  info(msg: string, fields?: LogFields): void { this.emit('info', msg, fields); }
  warn(msg: string, fields?: LogFields): void { this.emit('warn', msg, fields); }
  error(msg: string, fields?: LogFields): void { this.emit('error', msg, fields); }

  child(bindings: LogFields): Logger {
    return new JsonLogger({ ...this.bindings, ...bindings }, {
      level: rankToLevel(this.minRank),
      sink: this.sink,
    });
  }
}

function rankToLevel(rank: number): LogLevel {
  return (Object.keys(LEVEL_RANK) as LogLevel[]).find((l) => LEVEL_RANK[l] === rank) ?? 'info';
}

/** No-op logger for tests and callers that want silence. */
export class NullLogger implements Logger {
  debug(_msg: string, _fields?: LogFields): void {}
  info(_msg: string, _fields?: LogFields): void {}
  warn(_msg: string, _fields?: LogFields): void {}
  error(_msg: string, _fields?: LogFields): void {}
  child(_bindings: LogFields): Logger { return this; }
}
