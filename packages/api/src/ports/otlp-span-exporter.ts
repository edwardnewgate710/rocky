/**
 * @packageDocumentation
 * OTLP/JSON span exporter (M13 observability increment 3).
 * Maps SpanData arrays into standard OTLP/JSON traces payloads and passes
 * them to an injectable SpanTransport.
 */

import type { SpanData, SpanAttributeValue } from './tracer';
import type { OutcomeReportingSpanExporter } from './span-export';

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

export type SpanExportOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly retryable: boolean; readonly reason: string };

export interface SpanTransport {
  /**
   * Resolves with the delivery outcome and MUST NOT reject.
   *
   * Returning a promise does NOT make export blocking: nothing on the request path awaits it.
   * `OtlpJsonSpanExporter.export` stays `void` and simply attaches a handler.
   */
  send(payload: OtlpTracesPayload): Promise<SpanExportOutcome>;
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

export class OtlpJsonSpanExporter implements OutcomeReportingSpanExporter {
  constructor(
    private readonly transport: SpanTransport,
    private readonly resource: OtlpResourceInfo,
  ) {}

  /** Fire-and-forget. Callers wanting to know whether delivery worked use {@link exportWithOutcome}. */
  export(spans: readonly SpanData[]): void {
    void this.exportWithOutcome(spans);
  }

  async exportWithOutcome(spans: readonly SpanData[]): Promise<SpanExportOutcome> {
    if (spans.length === 0) return { ok: true };

    let payload: OtlpTracesPayload;
    try {
      payload = toResourceSpans(spans, this.resource);
    } catch {
      // Mapping the same spans will fail the same way every time, so this is permanent — retrying
      // it would burn attempts and hide the real fault behind a network-shaped reason.
      return { ok: false, retryable: false, reason: 'serialize' };
    }

    try {
      return await this.transport.send(payload);
    } catch {
      // The contract says send() must not reject; contain a transport that breaks it rather than
      // letting it surface as an unhandled rejection.
      return { ok: false, retryable: true, reason: 'transport_rejected' };
    }
  }
}

/**
 * Thin boundary adapter that POSTs serialized OTLP/JSON trace payloads to a URL.
 * Fire-and-forget; send() resolves with outcome and MUST NOT reject.
 */
export class FetchSpanTransport implements SpanTransport {
  constructor(
    private readonly endpoint: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(payload: OtlpTracesPayload): Promise<SpanExportOutcome> {
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const status = response.status;
        const retryable = status === 408 || status === 429 || status >= 500;
        return { ok: false, retryable, reason: `http_${status}` };
      }

      return { ok: true };
    } catch {
      return { ok: false, retryable: true, reason: 'network' };
    }
  }
}
