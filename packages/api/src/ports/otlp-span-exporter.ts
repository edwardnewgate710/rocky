/**
 * @packageDocumentation
 * OTLP/JSON span exporter (M13 observability increment 3).
 * Maps SpanData arrays into standard OTLP/JSON traces payloads and passes
 * them to an injectable SpanTransport.
 */

import type { SpanData, SpanAttributeValue } from './tracer';
import type { SpanExporter } from './span-export';

export type OtlpAnyValue =
  | { stringValue: string }
  | { intValue: string } // int64 encoded as a string
  | { boolValue: boolean }
  | { doubleValue: number };

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number; // 1 internal, 2 server, 3 client
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status: { code: number }; // 0 unset, 1 ok, 2 error
}

export interface OtlpResource {
  attributes: OtlpKeyValue[];
}

export interface OtlpScopeSpans {
  scope: { name: string; version: string };
  spans: OtlpSpan[];
}

export interface OtlpResourceSpans {
  resource: OtlpResource;
  scopeSpans: OtlpScopeSpans[];
}

export interface OtlpTracesPayload {
  resourceSpans: OtlpResourceSpans[];
}

export interface OtlpResourceInfo {
  serviceName: string;
  scopeName: string;
  scopeVersion: string;
}

export interface SpanTransport {
  send(payload: OtlpTracesPayload): void;
}

export function toOtlpAnyValue(v: SpanAttributeValue): OtlpAnyValue {
  if (typeof v === 'string') {
    return { stringValue: v };
  }
  if (typeof v === 'boolean') {
    return { boolValue: v };
  }
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  }
  return { stringValue: String(v) };
}

function mapKind(kind: SpanData['kind']): number {
  switch (kind) {
    case 'internal':
      return 1;
    case 'server':
      return 2;
    case 'client':
      return 3;
  }
}

function mapStatusCode(status: SpanData['status']): number {
  switch (status) {
    case 'unset':
      return 0;
    case 'ok':
      return 1;
    case 'error':
      return 2;
  }
}

export function toResourceSpans(
  spans: readonly SpanData[],
  resource: OtlpResourceInfo,
): OtlpTracesPayload {
  const otlpSpans: OtlpSpan[] = spans.map((span) => {
    const startTimeUnixNano = String(BigInt(span.startTimeMs) * 1000000n);
    const endTimeUnixNano = String(
      (BigInt(span.startTimeMs) + BigInt(span.durationMs)) * 1000000n,
    );
    const attributes: OtlpKeyValue[] = Object.entries(span.attributes).map(([key, value]) => ({
      key,
      value: toOtlpAnyValue(value),
    }));

    const otlpSpan: OtlpSpan = {
      traceId: span.traceId,
      spanId: span.spanId,
      ...(span.parentId !== null ? { parentSpanId: span.parentId } : {}),
      name: span.name,
      kind: mapKind(span.kind),
      startTimeUnixNano,
      endTimeUnixNano,
      attributes,
      status: { code: mapStatusCode(span.status) },
    };
    return otlpSpan;
  });

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: resource.serviceName } }],
        },
        scopeSpans: [
          {
            scope: {
              name: resource.scopeName,
              version: resource.scopeVersion,
            },
            spans: otlpSpans,
          },
        ],
      },
    ],
  };
}

/**
 * Resolve the OTLP/HTTP traces endpoint per the OpenTelemetry spec:
 * a signal-specific `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is used verbatim,
 * whereas the generic `OTEL_EXPORTER_OTLP_ENDPOINT` is a BASE url onto which
 * the `/v1/traces` signal path is appended (a lone trailing slash is trimmed
 * first). Returns `undefined` when neither is configured.
 */
export function resolveOtlpTracesEndpoint(
  tracesEndpoint: string | undefined,
  baseEndpoint: string | undefined,
): string | undefined {
  if (tracesEndpoint) return tracesEndpoint;
  if (baseEndpoint) return `${baseEndpoint.replace(/\/+$/, '')}/v1/traces`;
  return undefined;
}

export class OtlpJsonSpanExporter implements SpanExporter {
  constructor(
    private readonly transport: SpanTransport,
    private readonly resource: OtlpResourceInfo,
  ) {}

  export(spans: readonly SpanData[]): void {
    if (spans.length === 0) return;
    try {
      this.transport.send(toResourceSpans(spans, this.resource));
    } catch {
      /* swallow — export is best-effort */
    }
  }
}

/**
 * Thin boundary adapter that POSTs serialized OTLP/JSON trace payloads to a URL.
 * Fire-and-forget; never awaited, never throws.
 */
export class FetchSpanTransport implements SpanTransport {
  constructor(private readonly endpoint: string) {}

  send(payload: OtlpTracesPayload): void {
    try {
      fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      }).catch(() => {
        /* swallow network/http errors — best-effort */
      });
    } catch {
      /* swallow synchronous errors — best-effort */
    }
  }
}
