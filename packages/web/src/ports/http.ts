/**
 * HTTP transport port.
 *
 * The networking layer must not bind to a concrete HTTP engine. Everything above
 * this seam — the typed API client, retry policy and session/auth handling —
 * speaks only in {@link HttpRequest} / {@link HttpResponse}; the concrete engine
 * (the platform `fetch`) lives in a thin adapter below it. This keeps the client
 * framework-independent and unit-testable with an in-memory transport (no real
 * sockets), mirroring the port pattern used elsewhere in the frontend
 * (`LegalMoveOracle`) and by the engine bridge on the server side.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A fully-resolved request handed to the transport (URL/query/body already built). */
export interface HttpRequest {
  readonly method: HttpMethod;
  /** Absolute-or-origin-relative URL with query string already applied. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Serialized request body, or omitted for bodyless requests. */
  readonly body?: string;
  /** Abort signal used for client-side timeout / cancellation. */
  readonly signal?: AbortSignal;
  /**
   * Whether to send credentials (cookies) with the request. Default `false`.
   * Set to `'include'` for cross-origin cookie-based auth (M12 inc 2).
   */
  readonly credentials?: 'include' | 'omit' | 'same-origin';
}

/** A transport-level response. `status` is always present; `body` is raw text. */
export interface HttpResponse {
  readonly status: number;
  /** Lower-cased response header map. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * The seam: send a request, resolve with a response for ANY status code, and
 * reject only on a transport failure (offline, DNS, reset, abort). Mapping
 * non-2xx responses to typed errors is the {@link import('../net/http-client.js')}
 * layer's job, not the transport's.
 */
export interface HttpTransport {
  send(request: HttpRequest): Promise<HttpResponse>;
}

/**
 * `fetch`-based transport: the one place the frontend touches the platform
 * network API. Inject a custom `fetch` (or a fake transport) in tests.
 */
export class FetchTransport implements HttpTransport {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    const resolved = fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
    if (!resolved) {
      throw new Error('FetchTransport: no global fetch available; pass one explicitly');
    }
    this.fetchImpl = resolved.bind(globalThis) as typeof fetch;
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    const init: RequestInit = {
      method: request.method,
      headers: { ...request.headers },
    };
    if (request.body !== undefined) init.body = request.body;
    if (request.signal !== undefined) init.signal = request.signal;
    // M12 inc 2: pass credentials through so the httpOnly refresh cookie
    // is sent on refresh/logout and received on login/register.
    if (request.credentials !== undefined) init.credentials = request.credentials;

    const res = await this.fetchImpl(request.url, init);
    const body = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: res.status, headers, body };
  }
}
