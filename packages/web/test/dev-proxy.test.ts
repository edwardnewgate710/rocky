import { test } from 'node:test';
import assert from 'node:assert/strict';
import viteConfig from '../vite.config.js';

/**
 * The resolved config object, not the file's text.
 *
 * An earlier version of this test read `vite.config.ts` and searched it with hard-coded indentation,
 * quote style and a hand-rolled brace counter — so reformatting, changing quotes or a CRLF checkout
 * could fail CI while the proxy was perfectly correct, and a genuinely broken proxy written in a
 * different style could pass. Importing the config asserts what Vite will actually use.
 */
type ProxyTable = Record<string, { target?: unknown; ws?: boolean }>;

function proxyOf(kind: 'server' | 'preview'): ProxyTable {
  const config = viteConfig as { server?: { proxy?: ProxyTable }; preview?: { proxy?: ProxyTable } };
  const proxy = config[kind]?.proxy;
  assert.ok(proxy, `vite config declares no \`${kind}.proxy\``);
  return proxy!;
}

/**
 * `resolveEndpoints` in `src/app/config.ts` derives the API origin from `location.origin`, so the app
 * always calls `/v1/...` on whatever host serves it. That is correct in production, where nginx
 * proxies `/v1` to the API, and correct under `vite preview`, which had a proxy for the e2e
 * harness — but `vite dev` had none, so `npm run dev` served an app whose every API call 404'd.
 * Registering an account answered `HTTP 404`, which reads as a broken backend rather than a missing
 * two-line proxy.
 *
 * The parity between the two servers is the invariant, not the port numbers: a config that proxies
 * `/v1` for one and not the other is the shape of this bug, and it survived because nothing tested
 * `vite.config.ts` at all.
 */
test('the dev server proxies the same paths as preview, so `npm run dev` reaches the API', () => {
  for (const kind of ['server', 'preview'] as const) {
    const proxy = proxyOf(kind);
    assert.ok(proxy['/v1'], `\`${kind}\` must proxy /v1 — the REST prefix every API call uses`);
    assert.ok(proxy['/ws'], `\`${kind}\` must proxy /ws — the realtime connection`);
  }
});

/** A WebSocket route without `ws: true` silently stays HTTP and never upgrades. */
test('both proxies mark /ws as a WebSocket route', () => {
  for (const kind of ['server', 'preview'] as const) {
    assert.equal(proxyOf(kind)['/ws']?.ws, true, `\`${kind}\` /ws proxy must set \`ws: true\``);
  }
});

/** Every proxied path needs somewhere to send the request. */
test('every proxied path declares a target', () => {
  for (const kind of ['server', 'preview'] as const) {
    for (const [path, entry] of Object.entries(proxyOf(kind))) {
      assert.ok(entry.target, `\`${kind}\` proxy for ${path} has no target`);
    }
  }
});
