import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryMetrics } from '../src/ports/metrics.js';
import { ConsoleEmailSender } from '../src/ports/email.js';
import { ResendEmailSender } from '../src/email/resend-email-sender.js';

const TOKEN = 'raw-token-that-must-stay-out-of-observability';
const API_KEY = 're_provider-credential-that-must-stay-secret';
const TO = 'player@example.com';

function sender(fetchImpl: typeof fetch, metrics = new InMemoryMetrics(), timeoutMs = 100) {
  return {
    metrics,
    sender: new ResendEmailSender({
      apiKey: API_KEY,
      from: 'security@example.com',
      publicWebOrigin: 'https://chess.example.com',
      timeoutMs,
      fetch: fetchImpl,
      metrics,
    }),
  };
}

describe('ResendEmailSender', () => {
  it('sends a reset message through the fixed HTTPS endpoint with a non-secret idempotency key', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fakeFetch: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ id: 'email-id' }), { status: 200 });
    };
    const { sender: email, metrics } = sender(fakeFetch);

    assert.deepEqual(await email.sendPasswordReset(TO, TOKEN), { outcome: 'success' });
    assert.equal(capturedUrl, 'https://api.resend.com/emails');
    assert.equal(capturedInit?.method, 'POST');
    const headers = new Headers(capturedInit?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${API_KEY}`);
    assert.equal(headers.get('user-agent'), 'shatarang-api/0.1');
    assert.ok(!headers.get('idempotency-key')?.includes(TOKEN));
    const body = JSON.parse(String(capturedInit?.body));
    assert.deepEqual(body.to, [TO]);
    assert.match(body.text, /password-reset#token=raw-token/);
    assert.equal(body.tags[0].value, 'password_reset');
    assert.match(metrics.render(), /email_delivery_total\{outcome="success",purpose="password_reset"\} 1/);
  });

  it('sends verification through the fragment route', async () => {
    let body: Record<string, any> = {};
    const { sender: email } = sender(async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: 'email-id' }), { status: 200 });
    });

    assert.deepEqual(await email.sendEmailVerification(TO, TOKEN), { outcome: 'success' });
    assert.match(body.text, /email-verify#token=raw-token/);
    assert.equal(body.tags[0].value, 'email_verify');
  });

  it('bounds a hanging provider request and classifies the timeout', async () => {
    const hanging: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    const { sender: email } = sender(hanging, new InMemoryMetrics(), 5);

    assert.deepEqual(await email.sendPasswordReset(TO, TOKEN), { outcome: 'timeout' });
  });

  for (const [status, outcome] of [[422, 'provider_rejected'], [429, 'provider_throttled'], [503, 'provider_error']] as const) {
    it(`maps provider status ${status} to ${outcome} without parsing its body`, async () => {
      const response = new Response(
        JSON.stringify({ message: `${TOKEN} ${TO} ${API_KEY}` }),
        { status },
      );
      const { sender: email } = sender(async () => response);
      assert.deepEqual(await email.sendPasswordReset(TO, TOKEN), { outcome });
      assert.equal(response.bodyUsed, true, 'error response body must be discarded');
    });
  }

  it('preserves the provider outcome when discarding an error body fails', async () => {
    const response = {
      ok: false,
      status: 503,
      body: { cancel: async () => { throw new Error('discard failed'); } },
    } as unknown as Response;
    const { sender: email } = sender(async () => response);

    assert.deepEqual(await email.sendPasswordReset(TO, TOKEN), { outcome: 'provider_error' });
  });

  it('maps connection failures and malformed success responses to provider_error', async () => {
    const connection = sender(async () => { throw new Error(`${TOKEN} ${TO} ${API_KEY}`); }).sender;
    assert.deepEqual(await connection.sendPasswordReset(TO, TOKEN), { outcome: 'provider_error' });

    const malformed = sender(async () => new Response('{"unexpected":true}', { status: 200 })).sender;
    assert.deepEqual(await malformed.sendPasswordReset(TO, TOKEN), { outcome: 'provider_error' });
  });

  it('rejects an unsafe recipient before fetch and emits only bounded metric labels', async () => {
    let calls = 0;
    const metrics = new InMemoryMetrics();
    const { sender: email } = sender(async () => {
      calls += 1;
      return new Response(JSON.stringify({ id: 'email-id' }), { status: 200 });
    }, metrics);

    assert.deepEqual(
      await email.sendEmailVerification('safe@example.com\r\nBcc: victim@example.com', TOKEN),
      { outcome: 'provider_rejected' },
    );
    assert.equal(calls, 0);
    const rendered = metrics.render();
    assert.match(rendered, /email_delivery_total\{outcome="provider_rejected",purpose="email_verify"\} 1/);
    for (const secret of [TOKEN, TO, API_KEY, 'victim@example.com', 'https://chess.example.com/email-verify']) {
      assert.ok(!rendered.includes(secret));
    }
  });
});

it('ConsoleEmailSender never prints the recipient, token, or completed link', async () => {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    const email = new ConsoleEmailSender();
    assert.deepEqual(await email.sendPasswordReset(TO, TOKEN), { outcome: 'suppressed' });
    assert.deepEqual(await email.sendEmailVerification(TO, TOKEN), { outcome: 'suppressed' });
  } finally {
    console.log = original;
  }
  const output = lines.join('\n');
  assert.match(output, /password_reset/);
  assert.match(output, /email_verify/);
  for (const unsafe of [TOKEN, TO, '#token=', 'password-reset#', 'email-verify#']) {
    assert.ok(!output.includes(unsafe));
  }
});
