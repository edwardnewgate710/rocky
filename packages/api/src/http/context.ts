/**
 * @packageDocumentation
 * The per-request context handed to every route handler, plus the handler and
 * result types. Handlers are pure with respect to the transport: they receive a
 * {@link RequestContext} and return a {@link HandlerResult}; the router is the
 * only place that touches Node's `req`/`res`. This keeps handlers trivially
 * unit-testable without a live socket.
 */

import type { IncomingHttpHeaders } from 'node:http';
import type { Role } from '@chess-platform/persistence';
import type { Logger } from '../ports/logger';

/** The authenticated caller, resolved from a verified access token. */
export interface Identity {
  readonly userId: string;
  readonly handle: string;
  readonly roles: readonly Role[];
  /** Access-token id (jti), useful for correlation/audit. */
  readonly tokenId: string;
}

/** Everything a handler needs to know about the incoming request. */
export interface RequestContext {
  readonly method: string;
  readonly path: string;
  /** Path parameters captured from the route pattern (e.g. `:handle`). */
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly headers: IncomingHttpHeaders;
  /** Parsed JSON body, or `undefined` when absent. */
  readonly body: unknown;
  /** Correlation id echoed in responses and written to the audit log. */
  readonly requestId: string;
  /** W3C trace-id (adopted from `traceparent` or freshly minted). */
  readonly traceId: string;
  /** Per-request logger bound with `{ requestId, traceId, method, path }`. */
  readonly logger: Logger;
  readonly ip: string | null;
  readonly userAgent: string | null;
  /** Present only after authentication middleware resolves a valid token. */
  readonly auth: Identity | null;
}

/** What a handler returns; the router serializes it to the wire. */
export interface HandlerResult {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** A route handler: context in, result out (sync or async). */
export type Handler = (ctx: RequestContext) => Promise<HandlerResult> | HandlerResult;

/**
 * Convenience constructor for a JSON response. Optionally accepts response
 * headers (e.g. `Set-Cookie` for the httpOnly refresh cookie — M12 inc 2).
 */
export function json(
  status: number,
  body: unknown,
  headers?: Readonly<Record<string, string>>,
): HandlerResult {
  return headers ? { status, body, headers } : { status, body };
}

/** Convenience constructor for an empty `204 No Content` response. */
export function noContent(): HandlerResult {
  return { status: 204 };
}
