import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { startHarness } from './helpers';
import { joinRequestView, learnerStepView, teamView, teamDetailView, attemptResultView, capabilitiesView } from '../src/presenters';
import type { JoinRequest, Team } from '@chess-platform/community';
import type { AttemptResult, LessonStep } from '@chess-platform/learning';

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

/**
 * `TeamView` listed `updatedAt` in its `required` array. The `Team` domain type has no such field
 * and `teamView` has never emitted one, so the published contract promised every client a timestamp
 * the server does not send — the third instance of the drift ADR-0088 fixed for `ForumPostView` and
 * M14 increment 28 fixed for `JoinRequestView`, and it survived just as long for the same reason:
 * every route test reads the response, and none read the schema.
 *
 * `TeamDetailView` is pinned alongside it because it is new, and a contract is cheapest to hold
 * still from the day it is published.
 */
test('TeamView and TeamDetailView describe exactly what their presenters emit', async () => {
  const h = await startHarness();
  try {
    const schemas = (h.server.openapiDocument() as any).components.schemas;

    const team: Team = {
      id: 'e6f0b1a2-0000-4000-8000-000000000001',
      slug: 'a-team',
      name: 'A Team',
      description: 'Description',
      visibility: 'public',
      createdBy: 'e6f0b1a2-0000-4000-8000-000000000002',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    const listed = Object.keys(teamView(team)).sort();
    assert.deepEqual(listed, Object.keys(schemas.TeamView.properties).sort());
    assert.deepEqual(listed, [...schemas.TeamView.required].sort());

    // Both branches of the viewer's role: `required` lists presence, and a non-member is sent an
    // explicit null rather than having the key omitted.
    const asMember = teamDetailView(team, 'admin');
    const asStranger = teamDetailView(team, null);
    const detailKeys = Object.keys(asMember).sort();

    assert.deepEqual(detailKeys, Object.keys(schemas.TeamDetailView.properties).sort());
    assert.deepEqual(detailKeys, Object.keys(asStranger).sort());
    assert.deepEqual(detailKeys, [...schemas.TeamDetailView.required].sort());
    assert.equal(asStranger.viewerRole, null);
  } finally {
    await h.close();
  }
});

/**
 * The last presenter without one of these, added when `AttemptResult.message` was deleted
 * (ADR-0097). The same divergence has been found here three times — `ForumPostView` (ADR-0088),
 * `JoinRequestView` (increment 28) and `TeamView` (increment 30) — and each time it survived because
 * every route test reads the response and none read the schema.
 *
 * Unlike those, `completedAt` here is genuinely optional on both sides: the presenter spreads it
 * conditionally and the schema leaves it out of `required`. So the declared properties are checked
 * against the union of what both branches emit, and `required` is checked separately against the
 * keys that are always present. Asserting one against the other would fail on a correct contract.
 */
test('AttemptResultView: the served schema describes exactly what the presenter emits', async () => {
  const h = await startHarness();
  try {
    const schema = (h.server.openapiDocument() as any).components.schemas.AttemptResultView;

    const base = { stepId: 'e6f0b1a2-0000-4000-8000-000000000001', attempts: 2 };
    const inProgress: AttemptResult = { ...base, correct: false };
    const completed: AttemptResult = {
      ...base,
      correct: true,
      completedAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    const pending = attemptResultView(inProgress);
    const done = attemptResultView(completed);

    const emitted = [...new Set([...Object.keys(pending), ...Object.keys(done)])].sort();
    assert.deepEqual(emitted, Object.keys(schema.properties).sort());

    // `required` is what every response carries, which is the pending shape.
    assert.deepEqual([...schema.required].sort(), Object.keys(pending).sort());
    assert.equal('completedAt' in pending, false);
    assert.equal(typeof done.completedAt, 'string');
  } finally {
    await h.close();
  }
});

/**
 * Pin the `Capabilities` schema against `capabilitiesView` presenter output so they cannot drift.
 * Adding or removing a capability key from the presenter without updating `Capabilities` in `schemas.ts`
 * (or vice versa) fails this test.
 */
test('Capabilities: the served schema describes exactly what the presenter emits', async () => {
  const h = await startHarness();
  try {
    const schema = (h.server.openapiDocument() as any).components.schemas.Capabilities;
    const view = capabilitiesView({
      learningRepository: h.learningRepository,
      studiesRepository: h.studiesRepository,
      achievementsRepository: h.achievementsRepository,
      searchRepository: h.searchRepository,
      socialGraphRepository: h.socialGraphRepository,
      messagingRepository: h.messagingRepository,
      communityRepository: h.communityRepository,
    });

    const presenterKeys = Object.keys(view.capabilities).sort();
    const schemaDeclaredKeys = Object.keys(schema.properties.capabilities.properties).sort();
    const schemaRequiredKeys = [...schema.properties.capabilities.required].sort();

    assert.deepEqual(presenterKeys, schemaDeclaredKeys);
    assert.deepEqual(presenterKeys, schemaRequiredKeys);
  } finally {
    await h.close();
  }
});

/**
 * Pin `WebAuthnRegisterOptions` and `WebAuthnLoginOptions` schemas against service options output.
 */
test('WebAuthnOptions: served schemas match actual options emitted by service', async () => {
  const h = await startHarness();
  try {
    const schemas = (h.server.openapiDocument() as any).components.schemas;
    const { token } = await h.makeUser('optsuser');

    const regRes = await h.json('POST', '/v1/auth/webauthn/register/options', { token });
    assert.equal(regRes.status, 200);
    const regOptions = regRes.body;

    const regDeclaredKeys = Object.keys(schemas.WebAuthnRegisterOptions.properties).sort();
    assert.deepEqual(Object.keys(regOptions).sort(), regDeclaredKeys);
    assert.deepEqual([...schemas.WebAuthnRegisterOptions.required].sort(), regDeclaredKeys);
    assert.equal(regOptions.authenticatorSelection.residentKey, 'required');
    assert.equal('residentKey' in schemas.WebAuthnRegisterOptions.properties.authenticatorSelection.properties, true);
    assert.equal('requireResidentKey' in schemas.WebAuthnRegisterOptions.properties.authenticatorSelection.properties, false);

    const loginRes = await h.json('POST', '/v1/auth/webauthn/login/options', { body: { handle: 'optsuser' } });
    assert.equal(loginRes.status, 200);
    const loginOptions = loginRes.body;

    const loginRequiredKeys = [...schemas.WebAuthnLoginOptions.required].sort();
    assert.deepEqual(Object.keys(loginOptions).sort(), loginRequiredKeys);
    assert.equal(schemas.WebAuthnLoginOptions.required.includes('allowCredentials'), false);
  } finally {
    await h.close();
  }
});
