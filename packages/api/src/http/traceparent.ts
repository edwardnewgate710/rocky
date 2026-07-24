/**
 * @packageDocumentation
 * Minimal W3C Trace Context propagation (M13 observability). Hand-rolled parse
 * and format of the `traceparent` header — `version-traceid-spanid-flags` — with strict
 * hex/length validation. We adopt an inbound trace-id when valid and otherwise
 * mint a fresh one. Spans are recorded and trace context is propagated outbound;
 * only OTLP/collector export remains deferred.
 */

import { randomBytes } from 'node:crypto';

export interface Traceparent {
  readonly traceId: string; // 32 lowercase hex chars
  readonly parentId: string; // 16 lowercase hex chars
  readonly flags: string; // 2 lowercase hex chars
}

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/**
 * Parse and validate a `traceparent` header. Returns `null` for anything
 * malformed, an unsupported version, or the all-zero trace-id/parent-id that
 * the spec forbids.
 */
export function parseTraceparent(header: string | undefined): Traceparent | null {
  if (typeof header !== 'string') return null;
  const match = TRACEPARENT_RE.exec(header.trim().toLowerCase());
  if (!match) return null;
  const [, version, traceId, parentId, flags] = match;
  // Version 'ff' is invalid; we only accept the current '00' format.
  if (version !== '00') return null;
  if (traceId === '0'.repeat(32)) return null;
  if (parentId === '0'.repeat(16)) return null;
  return { traceId: traceId!, parentId: parentId!, flags: flags! };
}

/** Mint a fresh 16-byte (128-bit) trace-id as 32 lowercase hex chars. */
export function generateTraceId(): string {
  return randomBytes(16).toString('hex');
}

/** Mint a fresh 8-byte (64-bit) span-id as 16 lowercase hex chars. */
export function generateSpanId(): string {
  return randomBytes(8).toString('hex');
}

/** Format an outbound W3C traceparent header string. */
export function formatTraceparent(input: {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled: boolean;
}): string {
  const flags = input.sampled ? '01' : '00';
  return `00-${input.traceId}-${input.spanId}-${flags}`;
}

/** Check if the W3C traceparent flags indicate sampled (low bit set). */
export function isSampled(flags: string): boolean {
  return (parseInt(flags, 16) & 0x01) === 1;
}

