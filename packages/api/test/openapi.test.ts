import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { startHarness } from './helpers';
import { joinRequestView, learnerStepView } from '../src/presenters';
import type { JoinRequest } from '@chess-platform/community';
import type { LessonStep } from '@chess-platform/learning';

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

/**
 * Defining `LearnerStepView` and pointing the routes at it are two separate edits, and only the
 * second one changes what the published document promises. Reverting just the two `doc({ responses })
 * lines — leaving the presenter, the routes and both schemas intact — left the api suite at 0 failures while
 * `openapi.json` advertised `expectedSan` and `correctIndex` on routes that no longer send them.
 * The well-formedness test above cannot catch that: it checks every `$ref` resolves, never that a
 * schema is referenced, so an orphaned `LearnerStepView` is invisible to it.
 *
 * The PATCH assertion guards the other direction — a blanket rename that strips the answers from the
 * author too breaks authoring, and would otherwise pass.
 */
test('public step routes reference LearnerStepView/LearnerStepList schemas, authoring routes retain StepView', async () => {
  const h = await startHarness();
  try {
    const doc = h.server.openapiDocument() as any;

    const listRef = doc.paths['/v1/lessons/{id}/steps']?.get?.responses?.['200']?.content?.['application/json']?.schema?.$ref;
    assert.equal(listRef, '#/components/schemas/LearnerStepList');

    const getStepRef = doc.paths['/v1/steps/{id}']?.get?.responses?.['200']?.content?.['application/json']?.schema?.$ref;
    assert.equal(getStepRef, '#/components/schemas/LearnerStepView');

    const patchStepRef = doc.paths['/v1/steps/{id}']?.patch?.responses?.['200']?.content?.['application/json']?.schema?.$ref;
    assert.equal(patchStepRef, '#/components/schemas/StepView');
  } finally {
    await h.close();
  }
});

/**
 * Same coupling the `JoinRequestView` test above pins, for the view whose whole purpose is to leave
 * two fields out: the schema and the presenter are two declarations of one contract, and nothing else
 * makes them agree. A property added to `LearnerStepView` that the presenter never emits would put the
 * answer back in the published contract while every route test stayed green.
 *
 * Asserted as the union across all four kinds rather than per-fixture, because the view is a union of
 * three step kinds plus the tombstone — no single fixture can match the schema exactly, and the union
 * can. Fixtures are typed as the real `LessonStep`: a test that exists to catch contract drift has no
 * business opting out of the check that catches it.
 */
test('LearnerStepView: the served schema describes exactly what the presenter emits across all step kinds', async () => {
  const h = await startHarness();
  try {
    const schema = (h.server.openapiDocument() as any).components.schemas.LearnerStepView;

    const textStep: LessonStep = {
      id: 'e6f0b1a2-0000-4000-8000-000000000001',
      lessonId: 'e6f0b1a2-0000-4000-8000-000000000002',
      orderIndex: 0,
      kind: 'text',
      prose: 'Introduction to basic tactical themes.',
    };

    const moveStep: LessonStep = {
      id: 'e6f0b1a2-0000-4000-8000-000000000010',
      lessonId: 'e6f0b1a2-0000-4000-8000-000000000002',
      orderIndex: 1,
      kind: 'move',
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      expectedSan: 'e5',
      hint: 'Push e5',
    };

    const quizStep: LessonStep = {
      id: 'e6f0b1a2-0000-4000-8000-000000000011',
      lessonId: 'e6f0b1a2-0000-4000-8000-000000000002',
      orderIndex: 2,
      kind: 'quiz',
      question: 'What is the best move?',
      options: ['e4', 'd4', 'Nf3'],
      correctIndex: 0,
    };

    const deletedStep: LessonStep = {
      id: 'e6f0b1a2-0000-4000-8000-000000000012',
      lessonId: 'e6f0b1a2-0000-4000-8000-000000000002',
      orderIndex: 3,
      kind: 'text',
      prose: 'Tombstoned step.',
      deletedAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    const textView = learnerStepView(textStep);
    const moveView = learnerStepView(moveStep);
    const quizView = learnerStepView(quizStep);
    const deletedView = learnerStepView(deletedStep);

    assert.equal('expectedSan' in moveView, false);
    assert.equal('correctIndex' in quizView, false);
    assert.equal('expectedSan' in schema.properties, false);
    assert.equal('correctIndex' in schema.properties, false);

    const emittedKeysSet = new Set<string>([
      ...Object.keys(textView),
      ...Object.keys(moveView),
      ...Object.keys(quizView),
      ...Object.keys(deletedView),
    ]);

    const emittedKeys = [...emittedKeysSet].sort();
    const schemaDeclaredKeys = Object.keys(schema.properties).sort();

    assert.deepEqual(emittedKeys, schemaDeclaredKeys);
  } finally {
    await h.close();
  }
});
