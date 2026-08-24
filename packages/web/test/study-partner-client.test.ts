import assert from 'node:assert/strict';
import test from 'node:test';
import { StudyPartnerApi } from '../src/api/study-partner.js';
import type { ExecSpec } from '../src/api/client.js';

test('StudyPartnerApi sends only move authority plus required concurrency and idempotency data', async () => {
  const specs: ExecSpec[] = [];
  const execute = async <T>(spec: ExecSpec): Promise<T> => {
    specs.push(spec);
    return {} as T;
  };
  const api = new StudyPartnerApi(execute);
  await api.submitTurn('session/id', { move: 'e2e4', expectedVersion: 3 }, 'turn:4');
  assert.deepEqual(specs[0], {
    method: 'POST',
    path: '/v1/study-partner/sessions/session%2Fid/turns',
    auth: true,
    body: { move: 'e2e4', expectedVersion: 3 },
    headers: { 'Idempotency-Key': 'turn:4' },
    idempotent: true,
    permanentStatuses: [429, 503],
  });
});

test('StudyPartnerApi exposes exactly the five authorized routes', async () => {
  const specs: ExecSpec[] = [];
  const execute = async <T>(spec: ExecSpec): Promise<T> => {
    specs.push(spec);
    return {} as T;
  };
  const api = new StudyPartnerApi(execute);
  await api.create({ variant: 'standard', initialFen: 'fen' });
  await api.byId('id');
  await api.submitTurn('id', { move: 'e2e4', expectedVersion: 0 }, 'key');
  await api.end('id', 1);
  await api.delete('id');
  assert.deepEqual(specs.map(({ method, path }) => `${method} ${path}`), [
    'POST /v1/study-partner/sessions',
    'GET /v1/study-partner/sessions/id',
    'POST /v1/study-partner/sessions/id/turns',
    'POST /v1/study-partner/sessions/id/end',
    'DELETE /v1/study-partner/sessions/id',
  ]);
});
