import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { startHarness } from './helpers';
import { joinRequestView } from '../src/presenters';
import type { JoinRequest } from '@chess-platform/community';

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

/**
 * The published schema and the presenter that fills it are two separate declarations of one
 * contract, and nothing made them agree. `JoinRequestView` required an `updatedAt` the presenter
 * never emitted and omitted the `respondedAt` it always did, from M10 increment 4 until M14
 * increment 28 — the same drift ADR-0088 fixed for `ForumPostView`. Every route test passed
 * throughout, because they all read the response and none read the schema.
 *
 * Asserting the presenter's real output against the served document is what closes that: correcting
 * one side without the other now fails here.
 */
test('JoinRequestView: the served schema describes exactly what the presenter emits', async () => {
  const h = await startHarness();
  try {
    const schema = (h.server.openapiDocument() as any).components.schemas.JoinRequestView;

    // Both branches of `respondedAt: j.respondedAt ? ... : null` — the key set must not depend on
    // whether the request has been responded to, since the schema declares it required either way.
    // Typed as `JoinRequest` rather than asserted: a test that exists to catch contract drift has
    // no business opting out of the check that catches it. A new required field on the domain type
    // fails to compile here.
    const base = {
      id: 'e6f0b1a2-0000-4000-8000-000000000001',
      teamId: 'e6f0b1a2-0000-4000-8000-000000000002',
      playerId: 'e6f0b1a2-0000-4000-8000-000000000003',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const pendingRequest: JoinRequest = { ...base, status: 'pending' };
    const respondedRequest: JoinRequest = {
      ...base,
      status: 'accepted',
      respondedAt: new Date('2026-01-02T00:00:00.000Z'),
    };
    const pending = joinRequestView(pendingRequest);
    const responded = joinRequestView(respondedRequest);

    const declared = Object.keys(schema.properties).sort();
    assert.deepEqual(Object.keys(pending).sort(), declared);
    assert.deepEqual(Object.keys(responded).sort(), declared);

    // Required lists presence, not non-nullness: a pending request sends `respondedAt: null`.
    assert.deepEqual([...schema.required].sort(), declared);
    assert.equal(pending.respondedAt, null);
    assert.equal(typeof responded.respondedAt, 'string');
  } finally {
    await h.close();
  }
});
