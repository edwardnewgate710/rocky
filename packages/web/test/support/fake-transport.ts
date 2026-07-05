/**
 * Test double for {@link HttpTransport}: records requests and replays scripted
 * responses (or errors) without touching the network. Not a test file itself.
 */
import type { HttpRequest, HttpResponse, HttpTransport } from '../../src/ports/http.js';

export type Responder = (request: HttpRequest, callIndex: number) => HttpResponse | Error;

export class FakeTransport implements HttpTransport {
  readonly calls: HttpRequest[] = [];
  private readonly responders: Responder[];
  private fallback: Responder | undefined;

  constructor(...responders: Responder[]) {
    this.responders = responders;
  }

  /** Set a responder used for any call index beyond the scripted ones. */
  onEach(fallback: Responder): this {
    this.fallback = fallback;
    return this;
  }

  send(request: HttpRequest): Promise<HttpResponse> {
    const index = this.calls.length;
    this.calls.push(request);
    const responder = this.responders[index] ?? this.fallback;
    if (!responder) {
      return Promise.reject(new Error(`FakeTransport: no responder for call #${index}`));
    }
    const result = responder(request, index);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  }
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers, body: JSON.stringify(body) };
}

export function empty(status: number, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers, body: '' };
}

/** Transport whose request never resolves until its abort signal fires. */
export function abortableHang(): HttpTransport {
  return {
    send(request: HttpRequest): Promise<HttpResponse> {
      return new Promise<HttpResponse>((_resolve, reject) => {
        const signal = request.signal;
        if (!signal) return;
        const fail = (): void => reject(makeAbortError());
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      });
    },
  };
}

function makeAbortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}
