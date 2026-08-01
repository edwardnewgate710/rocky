/**
 * @packageDocumentation
 * Span export abstraction (M13 observability increment 3).
 *
 * Contract: `export` is best-effort and non-blocking — it MUST NOT throw and MUST NOT
 * perform slow synchronous work on the caller's thread; implementations that do I/O
 * queue/fire-and-forget internally and contain their own errors.
 */

import type { Logger } from './logger';
import type { SpanData, SpanAttributes, SpanAttributeValue, SpanSink } from './tracer';
import type { SpanExportOutcome } from './otlp-span-exporter';

export interface SpanExporter {
  export(spans: readonly SpanData[]): void;
}

/**
 * An exporter that can confirm whether a batch actually reached its destination.
 *
 * Kept separate from {@link SpanExporter} so the base port stays the one-method contract every
 * exporter can satisfy: {@link LoggingSpanExporter} writes to a logger and cannot fail in a way
 * worth reporting. {@link BatchSpanProcessor} uses this richer contract when the downstream
 * exporter offers it, and falls back to optimistic counting when it does not.
 *
 * The promise is what correlates a result with its batch — a callback set on the exporter cannot,
 * because several batches are in flight at once whenever a flush drains a full queue.
 */
export interface OutcomeReportingSpanExporter extends SpanExporter {
  /** Resolves with the delivery outcome. MUST NOT reject; callers must not await it. */
  exportWithOutcome(spans: readonly SpanData[]): Promise<SpanExportOutcome>;
}

/** Narrows an exporter to {@link OutcomeReportingSpanExporter}, or `undefined` if it cannot report. */
export function asOutcomeReporting(
  exporter: SpanExporter,
): OutcomeReportingSpanExporter | undefined {
  return typeof (exporter as Partial<OutcomeReportingSpanExporter>).exportWithOutcome === 'function'
    ? (exporter as OutcomeReportingSpanExporter)
    : undefined;
}

export const BOUNDED_SPAN_ATTRS = [
  'http.method',
  'http.route',
  'http.status_code',
  'cmd.kind',
  'cmd.outcome',
  'cmd.error_code',
  'forward.outcome',
  'forward.timeout',
] as const;

export function pickBoundedAttrs(attrs: SpanAttributes): Record<string, SpanAttributeValue> {
  const result: Record<string, SpanAttributeValue> = {};
  for (const key of BOUNDED_SPAN_ATTRS) {
    if (attrs[key] !== undefined) {
      result[key] = attrs[key];
    }
  }
  return result;
}

export class LoggingSpanExporter implements SpanExporter {
  constructor(private readonly logger: Logger) {}

  export(spans: readonly SpanData[]): void {
    for (const span of spans) {
      try {
        const { name, traceId, spanId, parentId, kind, status, durationMs, attributes } = span;
        this.logger.info('span', {
          name,
          traceId,
          spanId,
          parentId,
          kind,
          status,
          durationMs,
          ...pickBoundedAttrs(attributes),
        });
      } catch {
        /* swallow — export is best-effort */
      }
    }
  }
}

export class MultiSpanExporter implements SpanExporter {
  constructor(private readonly exporters: readonly SpanExporter[]) {}

  export(spans: readonly SpanData[]): void {
    for (const exporter of this.exporters) {
      try {
        exporter.export(spans);
      } catch {
        /* swallow — export is best-effort */
      }
    }
  }
}

export function spanSinkFromExporter(exporter: SpanExporter): SpanSink {
  return (span: SpanData): void => {
    // Honor the best-effort contract at the boundary: a misbehaving exporter
    // must never throw out of the tracer sink into the request path.
    try {
      exporter.export([span]);
    } catch {
      /* swallow — export is best-effort */
    }
  };
}
