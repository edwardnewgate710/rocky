/**
 * @packageDocumentation
 * A tiny, typed, dependency-free HTTP router built on Node's `http` module. It
 * compiles `/v1/users/:handle`-style patterns into segment matchers, resolves
 * path parameters, applies authentication + RBAC declaratively per route, and
 * normalizes every outcome into the JSON error envelope. Handlers never touch
 * the raw socket — they receive a {@link RequestContext} and return a
 * {@link HandlerResult}.
 */

import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { Role } from '@chess-platform/persistence';
import { HttpError } from './errors';
import { readJsonBody, DEFAULT_MAX_BODY_BYTES } from './body';
import type { Handler, HandlerResult, Identity, RequestContext } from './context';
import type { RouteDoc } from '../openapi/types';

/** HTTP methods the router dispatches. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Per-route authentication policy. */
export interface AuthPolicy {
  /** If true, a valid access token is required (401 otherwise). */
  readonly required: boolean;
  /** If set, the caller must hold at least one of these roles (403 otherwise). */
  readonly anyRole?: readonly Role[];
}

/** A route registration. */
export interface RouteDef {
  readonly method: HttpMethod;
  readonly path: string;
  readonly doc: RouteDoc;
  readonly auth: AuthPolicy;
  readonly handler: Handler;
}

interface CompiledRoute extends RouteDef {
  readonly segments: readonly string[];
  readonly paramNames: readonly string[];
}

/** Runtime collaborators the listener needs (all injected — no globals). */
export interface RouterRuntime {
  /**
   * Resolve an {@link Identity} from the `Authorization` header. Returns null for
   * an absent token and throws {@link HttpError} (401) for a malformed/expired
   * one.
   */
  readonly authenticate: (authorization: string | undefined) => Identity | null;
  readonly maxBodyBytes?: number;
  readonly newRequestId: () => string;
  /** Whether to trust `X-Forwarded-For` for the client IP (behind a proxy). */
  readonly trustProxy?: boolean;
  /** Sink for uncaught (non-HttpError) failures; defaults to `console.error`. */
  readonly onInternalError?: (err: unknown, requestId: string) => void;
}

const METHODS_WITH_BODY = new Set<HttpMethod>(['POST', 'PUT', 'PATCH', 'DELETE']);

function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

/** A declarative, typed HTTP router. */
export class Router {
  private readonly routes: CompiledRoute[] = [];

  /** Register a route. Returns `this` for chaining. */
  add(def: RouteDef): this {
    const segments = splitPath(def.path);
    const paramNames = segments
      .filter((s) => s.startsWith(':'))
      .map((s) => s.slice(1));
    this.routes.push({ ...def, segments, paramNames });
    return this;
  }

  get(path: string, doc: RouteDoc, auth: AuthPolicy, handler: Handler): this {
    return this.add({ method: 'GET', path, doc, auth, handler });
  }
  post(path: string, doc: RouteDoc, auth: AuthPolicy, handler: Handler): this {
    return this.add({ method: 'POST', path, doc, auth, handler });
  }
  put(path: string, doc: RouteDoc, auth: AuthPolicy, handler: Handler): this {
    return this.add({ method: 'PUT', path, doc, auth, handler });
  }
  patch(path: string, doc: RouteDoc, auth: AuthPolicy, handler: Handler): this {
    return this.add({ method: 'PATCH', path, doc, auth, handler });
  }
  delete(path: string, doc: RouteDoc, auth: AuthPolicy, handler: Handler): this {
    return this.add({ method: 'DELETE', path, doc, auth, handler });
  }

  /** All registered routes, for OpenAPI generation. */
  list(): readonly RouteDef[] {
    return this.routes;
  }

  /**
   * Match a method + pathname. Returns the matched route with captured params,
   * or reports whether the path exists under other methods (for 405 vs 404).
   */
  match(
    method: string,
    pathname: string,
  ): { route: CompiledRoute; params: Record<string, string> } | { allow: HttpMethod[] } {
    const segments = splitPath(pathname);
    const allow = new Set<HttpMethod>();
    for (const route of this.routes) {
      if (route.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const pat = route.segments[i]!;
        const val = segments[i]!;
        if (pat.startsWith(':')) {
          try {
            params[pat.slice(1)] = decodeURIComponent(val);
          } catch (error) {
            if (error instanceof URIError) throw HttpError.badRequest('path contains invalid percent encoding');
            throw error;
          }
        } else if (pat !== val) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      allow.add(route.method);
      if (route.method === method) return { route, params };
    }
    return { allow: [...allow] };
  }

  /** Build a Node `http` request listener bound to this route table. */
  toListener(runtime: RouterRuntime): RequestListener {
    const maxBody = runtime.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    const onInternal =
      runtime.onInternalError ??
      ((err: unknown, requestId: string): void => {
        // eslint-disable-next-line no-console
        console.error(`[api] internal error (request ${requestId}):`, err);
      });

    return (req: IncomingMessage, res: ServerResponse): void => {
      void this.dispatch(req, res, runtime, maxBody, onInternal);
    };
  }

  private async dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    runtime: RouterRuntime,
    maxBody: number,
    onInternal: (err: unknown, requestId: string) => void,
  ): Promise<void> {
    const requestId = headerString(req.headers['x-request-id']) ?? runtime.newRequestId();
    res.setHeader('X-Request-Id', requestId);

    try {
      const host = headerString(req.headers.host) ?? 'localhost';
      const url = new URL(req.url ?? '/', `http://${host}`);
      const method = (req.method ?? 'GET').toUpperCase();

      const matched = this.match(method, url.pathname);
      if ('allow' in matched) {
        if (matched.allow.length > 0) {
          res.setHeader('Allow', matched.allow.join(', '));
          throw new HttpError(405, 'bad_request', `method ${method} not allowed`);
        }
        throw HttpError.notFound(`no route for ${method} ${url.pathname}`);
      }
      const { route, params } = matched;

      const body = METHODS_WITH_BODY.has(route.method)
        ? await readJsonBody(req, maxBody)
        : undefined;

      const auth = runtime.authenticate(headerString(req.headers.authorization));
      if (route.auth.required && !auth) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        throw HttpError.unauthorized();
      }
      if (auth && route.auth.anyRole && route.auth.anyRole.length > 0) {
        const permitted = route.auth.anyRole.some((r) => auth.roles.includes(r));
        if (!permitted) throw HttpError.forbidden();
      }

      const ctx: RequestContext = {
        method: route.method,
        path: url.pathname,
        params,
        query: url.searchParams,
        headers: req.headers,
        body,
        requestId,
        ip: clientIp(req, runtime.trustProxy ?? false),
        userAgent: headerString(req.headers['user-agent']) ?? null,
        auth,
      };

      const result = await route.handler(ctx);
      writeResult(res, result);
    } catch (err) {
      if (err instanceof HttpError) {
        writeResult(res, {
          status: err.status,
          headers: err.headers,
          body: {
            error: {
              code: err.code,
              message: err.message,
              ...(err.details ? { details: err.details } : {}),
              requestId,
            },
          },
        });
        return;
      }
      onInternal(err, requestId);
      writeResult(res, {
        status: 500,
        body: { error: { code: 'internal', message: 'internal server error', requestId } },
      });
    }
  }
}

function writeResult(res: ServerResponse, result: HandlerResult): void {
  if (result.headers) {
    for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
  }
  if (result.status === 204 || result.body === undefined) {
    res.writeHead(result.status);
    res.end();
    return;
  }
  const payload = JSON.stringify(result.body);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.writeHead(result.status);
  res.end(payload);
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string | null {
  if (trustProxy) {
    const fwd = headerString(req.headers['x-forwarded-for']);
    if (fwd) {
      const first = fwd.split(',')[0]!.trim();
      if (first) return first;
    }
  }
  return req.socket.remoteAddress ?? null;
}
