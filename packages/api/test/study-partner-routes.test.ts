import assert from 'node:assert/strict';
import test from 'node:test';
import { Position } from '@chess-platform/core';
import { startHarness } from './helpers.js';
import { DEFAULT_RATE_LIMIT } from '../src/config.js';

const START = Position.initial('standard').fen();

test('Study Partner routes require authentication', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const id = '00000000-0000-7000-8000-000000000001';
  const requests = [
    ['POST', '/v1/study-partner/sessions', { variant: 'standard', initialFen: START }],
    ['GET', `/v1/study-partner/sessions/${id}`, undefined],
    ['POST', `/v1/study-partner/sessions/${id}/turns`, { move: 'e2e4', expectedVersion: 0 }],
    ['POST', `/v1/study-partner/sessions/${id}/end`, { expectedVersion: 0 }],
    ['DELETE', `/v1/study-partner/sessions/${id}`, undefined],
  ] as const;
  for (const [method, path, body] of requests) {
    const response = await h.json(method, path, body === undefined ? {} : { body });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
});

test('Study Partner provides the complete private linear lifecycle', async (t) => {
  const h = await startHarness({
    rateLimit: {
      ...DEFAULT_RATE_LIMIT,
      coach: {
        perUser: { maxRequests: 1, windowMs: 60_000 },
        perIp: { maxRequests: 10, windowMs: 60_000 },
      },
    },
  });
  t.after(() => h.close());
  const owner = await h.makeUser('study-owner');

  const created = await h.json('POST', '/v1/study-partner/sessions', {
    token: owner.token,
    body: { variant: 'standard', initialFen: START },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.version, 0);
  assert.equal(created.body.currentFen, START);
  assert.deepEqual(created.body.turns, []);
  const id = created.body.id as string;

  const first = await h.json('POST', `/v1/study-partner/sessions/${id}/turns`, {
    token: owner.token,
    headers: { 'Idempotency-Key': 'first-turn' },
    body: { move: 'e2e4', expectedVersion: 0 },
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.replayed, false);
  assert.equal(first.body.turn.fenBefore, START);
  assert.equal(first.body.turn.fenAfter, Position.fromFen(START).play('e2e4').fen());
  assert.equal(first.body.turn.sessionVersion, 1);
  const serialized = JSON.stringify(first.body);
  for (const forbidden of ['providerId', 'model', 'solutionMove', 'solutionLine', 'prompt']) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked`);
  }

  const replay = await h.json('POST', `/v1/study-partner/sessions/${id}/turns`, {
    token: owner.token,
    headers: { 'Idempotency-Key': 'first-turn' },
    body: { move: 'e2e4', expectedVersion: 0 },
  });
  assert.equal(replay.status, 200, 'a replay must not spend the one remaining Coach admission');
  assert.equal(replay.body.replayed, true);
  assert.deepEqual(replay.body.turn, first.body.turn);

  const resumed = await h.json('GET', `/v1/study-partner/sessions/${id}`, { token: owner.token });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.version, 1);
  assert.equal(resumed.body.turnCount, 1);
  assert.equal(resumed.body.turns.length, 1);

  const ended = await h.json('POST', `/v1/study-partner/sessions/${id}/end`, {
    token: owner.token,
    body: { expectedVersion: 1 },
  });
  assert.equal(ended.status, 200);
  assert.equal(ended.body.status, 'completed');
  const completedAt = ended.body.completedAt;
  h.clock.advance(60_000);
  const repeatedEnd = await h.json('POST', `/v1/study-partner/sessions/${id}/end`, {
    token: owner.token,
    body: { expectedVersion: 1 },
  });
  assert.equal(repeatedEnd.status, 200);
  assert.equal(repeatedEnd.body.completedAt, completedAt);
  assert.equal(repeatedEnd.body.version, ended.body.version);

  const removed = await h.json('DELETE', `/v1/study-partner/sessions/${id}`, { token: owner.token });
  assert.equal(removed.status, 204);
  assert.equal((await h.json('GET', `/v1/study-partner/sessions/${id}`, { token: owner.token })).status, 404);
});

test('Study Partner rejects caller authority, malformed keys, and stale versions', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const owner = await h.makeUser('strict-owner');
  const rejectedBodies = [
    { variant: 'standard', initialFen: START, currentFen: START },
    { variant: 'standard', initialFen: START, model: 'cheap-model' },
    { variant: 'atomic', initialFen: START },
  ];
  for (const body of rejectedBodies) {
    const response = await h.json('POST', '/v1/study-partner/sessions', { token: owner.token, body });
    assert.equal(response.status, 422);
  }
  const created = await h.json('POST', '/v1/study-partner/sessions', {
    token: owner.token,
    body: { variant: 'standard', initialFen: START },
  });
  const id = created.body.id as string;

  const missingKey = await h.json('POST', `/v1/study-partner/sessions/${id}/turns`, {
    token: owner.token,
    body: { move: 'e2e4', expectedVersion: 0 },
  });
  assert.equal(missingKey.status, 422);
  const malformedKey = await h.json('POST', `/v1/study-partner/sessions/${id}/turns`, {
    token: owner.token,
    headers: { 'Idempotency-Key': 'contains a space' },
    body: { move: 'e2e4', expectedVersion: 0 },
  });
  assert.equal(malformedKey.status, 422);
  const manufactured = await h.json('POST', `/v1/study-partner/sessions/${id}/turns`, {
    token: owner.token,
    headers: { 'Idempotency-Key': 'manufactured' },
    body: { move: 'e2e4', expectedVersion: 0, nextFen: START },
  });
  assert.equal(manufactured.status, 422);
  const stale = await h.json('POST', `/v1/study-partner/sessions/${id}/turns`, {
    token: owner.token,
    headers: { 'Idempotency-Key': 'stale' },
    body: { move: 'e2e4', expectedVersion: 1 },
  });
  assert.equal(stale.status, 409);
  const accepted = await h.json('POST', `/v1/study-partner/sessions/${id}/turns`, {
    token: owner.token,
    headers: { 'Idempotency-Key': 'payload-bound' },
    body: { move: 'e2e4', expectedVersion: 0 },
  });
  assert.equal(accepted.status, 200);
  const changedPayload = await h.json('POST', `/v1/study-partner/sessions/${id}/turns`, {
    token: owner.token,
    headers: { 'Idempotency-Key': 'payload-bound' },
    body: { move: 'd2d4', expectedVersion: 0 },
  });
  assert.equal(changedPayload.status, 422);
});

test('foreign and missing Study Partner ids are the same 404 on every owner-scoped operation', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const owner = await h.makeUser('private-owner');
  const stranger = await h.makeUser('private-stranger');
  const created = await h.json('POST', '/v1/study-partner/sessions', {
    token: owner.token,
    body: { variant: 'standard', initialFen: START },
  });
  const foreignId = created.body.id as string;
  const missingId = '00000000-0000-7000-8000-999999999999';
  for (const id of [foreignId, missingId]) {
    const requests = [
      await h.json('GET', `/v1/study-partner/sessions/${id}`, { token: stranger.token }),
      await h.json('POST', `/v1/study-partner/sessions/${id}/turns`, {
        token: stranger.token,
        headers: { 'Idempotency-Key': `turn-${id}` },
        body: { move: 'e2e4', expectedVersion: 0 },
      }),
      await h.json('POST', `/v1/study-partner/sessions/${id}/end`, {
        token: stranger.token,
        body: { expectedVersion: 0 },
      }),
      await h.json('DELETE', `/v1/study-partner/sessions/${id}`, { token: stranger.token }),
    ];
    for (const response of requests) assert.equal(response.status, 404);
  }
});

test('Study Partner routes fail closed when the production Coach path is absent', async (t) => {
  const h = await startHarness({}, { withoutCoach: true });
  t.after(() => h.close());
  const owner = await h.makeUser('no-coach');
  const response = await h.json('POST', '/v1/study-partner/sessions', {
    token: owner.token,
    body: { variant: 'standard', initialFen: START },
  });
  assert.equal(response.status, 503);
});
