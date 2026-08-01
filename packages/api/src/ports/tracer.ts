/**
 * @packageDocumentation
 * Distributed tracing port (M13 observability). Dependency-free: `NullTracer` is
 * the silent default; `RecordingTracer` records spans to a `SpanSink` (such as
 * structured logs or an in-memory buffer); `InMemorySpanRecorder` is a bounded
 * ring buffer for testing and introspection.
 *
 * PII/cardinality discipline: NEVER put userId, gameId, handle, IP, token, email,
 * or any unbounded/secret value in a span name or attribute; use the route
 * PATTERN, bounded enums, and numeric codes only.
 */

import { generateSpanId as defaultGenerateSpanId } from '../http/traceparent';

export type SpanKind = 'server' | 'client' | 'internal';

export type SpanStatus = 'unset' | 'ok' | 'error';

export type SpanAttributeValue = string | number | boolean;

export type SpanAttributes = Readonly<Record<string, SpanAttributeValue>>;

export interface Span {
  setAttribute(key: string, value: SpanAttributeValue): void;
  setStatus(status: SpanStatus): void;
  end(): void;
  /** Span id used for outbound `traceparent` propagation — always a valid 16-hex id. */
  readonly spanId: string;
  /** Whether this span is recorded/sampled — drives the outbound sampled flag. */
  readonly sampled: boolean;
}

export interface SpanData {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentId: string | null;
  readonly kind: SpanKind;
  readonly status: SpanStatus;
  readonly startTimeMs: number;
  readonly durationMs: number;
  readonly attributes: SpanAttributes;
}

export interface StartSpanOptions {
  readonly traceId: string;
  readonly parentId?: string;
  readonly kind?: SpanKind;
  readonly attributes?: SpanAttributes;
  /** Inbound W3C `flags` sampled bit, when known. */
  readonly sampledFlag?: boolean;
}

export interface Tracer {
  startSpan(name: string, options: StartSpanOptions): Span;
}

export type SpanSink = (span: SpanData) => void;

export type Sampler = (input: {
  readonly traceId: string;
  readonly parentSampled: boolean | undefined;
}) => boolean;

/** Default always-on sampler. Respects parent decision when present. */
export const alwaysOnSampler: Sampler = ({ parentSampled }) => {
  if (typeof parentSampled === 'boolean') return parentSampled;
  return true;
};

/**
 * Deterministic probability sampler based on the traceId.
 * Derives an integer from the first 8 hex characters of traceId.
 * Respects parent decision when present.
 */
export function probabilitySampler(ratio: number): Sampler {
  const clampedRatio = Math.max(0, Math.min(1, ratio));
  return ({ traceId, parentSampled }) => {
    if (typeof parentSampled === 'boolean') {
      return parentSampled;
    }
    if (clampedRatio >= 1) return true;
    if (clampedRatio <= 0) return false;

    const hex8 = traceId.slice(0, 8);
    const parsedInt = parseInt(hex8, 16);
    if (Number.isNaN(parsedInt)) return false;

    return parsedInt / 0xffffffff < clampedRatio;
  };
}

/**
 * Turns an `OTEL_TRACES_SAMPLER_ARG` value into a sampler, rejecting anything that is not a
 * probability.
 *
 * This validation cannot live inside {@link probabilitySampler}: it clamps with `Math.max`/
 * `Math.min`, and both propagate `NaN`, so a ratio of `NaN` fails every comparison in the returned
 * sampler and silently samples NOTHING. A typo in one env var would switch tracing off across a
 * whole deployment with no error anywhere — so the caller gets a `warning` to log and always-on
 * sampling rather than silence.
 *
 * Returns rather than logs so it stays pure; every caller already has a logger.
 */
export function resolveTracesSampler(samplerArg: string | undefined): {
  sampler: Sampler;
  warning?: string;
} {
  if (samplerArg === undefined || samplerArg === '') {
    return { sampler: alwaysOnSampler };
  }
  const ratio = Number(samplerArg);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    return {
      sampler: alwaysOnSampler,
      warning: `OTEL_TRACES_SAMPLER_ARG must be a number in [0, 1]; ignoring "${samplerArg}" and sampling everything`,
    };
  }
  return { sampler: probabilitySampler(ratio) };
}

/**
 * A span that records nothing but still carries a valid propagation id, so an
 * unsampled request (or the {@link NullTracer}) can still be a well-formed
 * parent in an outbound `traceparent` — `parseTraceparent` rejects all-zero ids.
 */
class NoOpSpan implements Span {
  readonly sampled = false;
  constructor(readonly spanId: string) {}
  setAttribute(_key: string, _value: SpanAttributeValue): void {}
  setStatus(_status: SpanStatus): void {}
  end(): void {}
}

/** No-op tracer for silent default operation; still mints valid propagation ids. */
export class NullTracer implements Tracer {
  private readonly generateSpanId: () => string;

  constructor(generateSpanId: () => string = defaultGenerateSpanId) {
    this.generateSpanId = generateSpanId;
  }

  startSpan(_name: string, _options: StartSpanOptions): Span {
    return new NoOpSpan(this.generateSpanId());
  }
}

class RecordingSpan implements Span {
  readonly spanId: string;
  readonly sampled = true;
  private readonly name: string;
  private readonly traceId: string;
  private readonly parentId: string | null;
  private readonly kind: SpanKind;
  private status: SpanStatus = 'unset';
  private readonly startTimeMs: number;
  private readonly attributes: Record<string, SpanAttributeValue>;
  private readonly sink: SpanSink;
  private readonly now: () => number;
  private ended = false;

  constructor(
    name: string,
    options: StartSpanOptions,
    spanId: string,
    sink: SpanSink,
    now: () => number,
  ) {
    this.name = name;
    this.traceId = options.traceId;
    this.parentId = options.parentId ?? null;
    this.kind = options.kind ?? 'internal';
    this.startTimeMs = now();
    this.attributes = options.attributes ? { ...options.attributes } : {};
    this.spanId = spanId;
    this.sink = sink;
    this.now = now;
  }

  setAttribute(key: string, value: SpanAttributeValue): void {
    if (this.ended) return;
    this.attributes[key] = value;
  }

  setStatus(status: SpanStatus): void {
    if (this.ended) return;
    this.status = status;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    const durationMs = this.now() - this.startTimeMs;
    const spanData: SpanData = {
      name: this.name,
      traceId: this.traceId,
      spanId: this.spanId,
      parentId: this.parentId,
      kind: this.kind,
      status: this.status,
      startTimeMs: this.startTimeMs,
      durationMs,
      attributes: { ...this.attributes },
    };
    // Export is best-effort: a throwing sink (e.g. a failing log write) must
    // never escape end() into the request path, where the response may already
    // have been written and a second write would be attempted.
    try {
      this.sink(spanData);
    } catch {
      /* swallow — tracing export failures never break the request */
    }
  }
}

export interface RecordingTracerOptions {
  readonly sink: SpanSink;
  readonly sampler?: Sampler;
  readonly now?: () => number;
  readonly generateSpanId?: () => string;
}

/** Tracer that records completed spans to a sink. */
export class RecordingTracer implements Tracer {
  private readonly sink: SpanSink;
  private readonly sampler: Sampler;
  private readonly now: () => number;
  private readonly generateSpanId: () => string;

  constructor(options: RecordingTracerOptions) {
    this.sink = options.sink;
    this.sampler = options.sampler ?? alwaysOnSampler;
    this.now = options.now ?? Date.now;
    this.generateSpanId = options.generateSpanId ?? defaultGenerateSpanId;
  }

  startSpan(name: string, options: StartSpanOptions): Span {
    // Always mint a valid span id so an unsampled request still propagates a
    // well-formed `traceparent` (all-zero parent ids are rejected downstream).
    const spanId = this.generateSpanId();
    const isSampled = this.sampler({
      traceId: options.traceId,
      parentSampled: options.sampledFlag,
    });

    if (!isSampled) {
      return new NoOpSpan(spanId);
    }

    return new RecordingSpan(name, options, spanId, this.sink, this.now);
  }
}

export interface InMemorySpanRecorderOptions {
  readonly capacity?: number;
}

/** Bounded ring-buffer span sink for testing and introspection. */
export class InMemorySpanRecorder {
  private readonly capacity: number;
  private readonly buffer: SpanData[] = [];
  readonly record: SpanSink;

  constructor(options: InMemorySpanRecorderOptions = {}) {
    this.capacity = options.capacity ?? 1000;
    this.record = (span: SpanData): void => {
      this.buffer.push(span);
      if (this.buffer.length > this.capacity) {
        this.buffer.shift();
      }
    };
  }

  spans(): readonly SpanData[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer.length = 0;
  }
}
