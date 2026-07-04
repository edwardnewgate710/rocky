import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { startHarness } from './helpers';

function collectRefs(node: unknown, acc: string[]): void {
  if (Array.isArray(node)) {
    for (const x of node) collectRefs(x, acc);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') acc.push(v);
      else collectRefs(v, acc);
    }
  }
}

test('OpenAPI document is well-formed and self-consistent', async () => {
  const h = await startHarness();
  try {
    const doc = h.server.openapiDocument() as any;
    assert.equal(doc.openapi, '3.1.0');
    assert.equal(doc.info.title, 'Gambit API');
    assert.equal(doc.info.license.identifier, 'AGPL-3.0-or-later');

    // Every registered route appears (in OpenAPI `{param}` form) with responses.
    for (const route of h.server.router.list()) {
      const p = route.path
        .split('/')
        .map((s) => (s.startsWith(':') ? `{${s.slice(1)}}` : s))
        .join('/');
      const op = doc.paths[p]?.[route.method.toLowerCase()];
      assert.ok(op, `missing operation ${route.method} ${p}`);
      assert.ok(op.responses && Object.keys(op.responses).length > 0, `no responses for ${p}`);
      assert.ok(op.operationId, `no operationId for ${p}`);
    }

    // The bearer security scheme is declared.
    assert.equal(doc.components.securitySchemes.bearerAuth.scheme, 'bearer');

    // Every $ref resolves to a defined component schema.
    const refs: string[] = [];
    collectRefs(doc.paths, refs);
    collectRefs(doc.components.schemas, refs);
    for (const ref of refs) {
      assert.ok(ref.startsWith('#/components/schemas/'), `unexpected ref ${ref}`);
      const name = ref.replace('#/components/schemas/', '');
      assert.ok(doc.components.schemas[name], `dangling ref: ${ref}`);
    }
  } finally {
    await h.close();
  }
});

test('protected operations declare bearer security', async () => {
  const h = await startHarness();
  try {
    const doc = h.server.openapiDocument() as any;
    const me = doc.paths['/v1/users/me'].get;
    assert.deepEqual(me.security, [{ bearerAuth: [] }]);
    // The admin role grant requires bearer and documents a 403.
    const grant = doc.paths['/v1/users/{userId}/roles'].post;
    assert.deepEqual(grant.security, [{ bearerAuth: [] }]);
    assert.ok(grant.responses['403']);
    // Public endpoints have no security requirement.
    assert.equal(doc.paths['/v1/health'].get.security, undefined);
  } finally {
    await h.close();
  }
});

test('the spec is served at GET /v1/openapi.json', async () => {
  const h = await startHarness();
  try {
    const res = await h.json('GET', '/v1/openapi.json');
    assert.equal(res.status, 200);
    assert.equal(res.body.openapi, '3.1.0');
    assert.ok(res.body.paths['/v1/auth/login']);
  } finally {
    await h.close();
  }
});
