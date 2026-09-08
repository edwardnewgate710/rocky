import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { startHarness } from './helpers';

describe('Trusted Edge Contract: API Rate Limit Spoof Resistance', () => {
  test('client cannot bypass per-IP rate limiting by prepending spoofed IPs in X-Forwarded-For', async () => {
    // Harness with trustProxy enabled (1 proxy hop behind nginx).
    // In production, nginx appends $remote_addr to incoming X-Forwarded-For ($proxy_add_x_forwarded_for).
    // A client at real IP 198.51.100.1 sending forged XFF values results in header:
    // "spoofed-ip, 198.51.100.1"
    const h = await startHarness({ trustProxy: true });
    try {
      const realClientIp = '198.51.100.1';

      // DEFAULT_RATE_LIMIT.register.perIp is 5 requests per hour.
      // An attacker attempts 6 registrations from realClientIp, varying the spoofed prefix each time.
      for (let i = 0; i < 5; i++) {
        const spoofedPrefix = `203.0.113.${i + 1}`;
        const xffHeader = `${spoofedPrefix}, ${realClientIp}`;
        const res = await h.json('POST', '/v1/auth/register', {
          body: { handle: `spoofuser${i}`, password: 'password123' },
          headers: { 'x-forwarded-for': xffHeader },
        });
        assert.equal(res.status, 201, `Request ${i + 1} should be admitted (status 201)`);
      }

      // 6th request from the same real IP must be rate-limited (429),
      // even if the attacker invents a new spoofed prefix!
      const blocked = await h.json('POST', '/v1/auth/register', {
        body: { handle: 'spoofuser6', password: 'password123' },
        headers: { 'x-forwarded-for': `203.0.113.99, ${realClientIp}` },
      });

      assert.equal(
        blocked.status,
        429,
        `Expected request 6 to be rate limited (429) for real IP ${realClientIp}, but got status ${blocked.status} (body: ${JSON.stringify(blocked.body)})`,
      );
      assert.equal(blocked.body.error.code, 'rate_limited');
    } finally {
      await h.close();
    }
  });
});
