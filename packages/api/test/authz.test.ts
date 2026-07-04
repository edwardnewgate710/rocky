import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Role } from '@chess-platform/persistence';
import { startHarness } from './helpers';

/**
 * Authorization matrix. Each row asserts the status a caller of a given role (or
 * anonymous) receives from a protected operation. This is the M4 authZ-matrix
 * acceptance test.
 */

interface Case {
  readonly label: string;
  readonly roles: Role[] | null; // null = anonymous
  readonly expected: number;
}

test('authZ matrix: POST /v1/users/:id/roles is admin-only', async () => {
  const cases: Case[] = [
    { label: 'anonymous', roles: null, expected: 401 },
    { label: 'user', roles: ['user'], expected: 403 },
    { label: 'coach', roles: ['coach'], expected: 403 },
    { label: 'moderator', roles: ['moderator'], expected: 403 },
    { label: 'admin', roles: ['admin'], expected: 204 },
  ];

  for (const c of cases) {
    const h = await startHarness();
    try {
      const target = await h.makeUser('target-user');
      const token = c.roles ? (await h.makeUser(`actor-${c.label}`, c.roles)).token : undefined;
      const res = await h.json('POST', `/v1/users/${target.userId}/roles`, {
        token,
        body: { role: 'coach' },
      });
      assert.equal(res.status, c.expected, `${c.label} should get ${c.expected}`);
      if (c.expected === 204) {
        const roles = await h.repos.users.rolesOf(target.userId);
        assert.ok(roles.includes('coach'));
      }
    } finally {
      await h.close();
    }
  }
});

test('authZ matrix: /v1/users/me requires any authenticated user', async () => {
  const h = await startHarness();
  try {
    const anon = await h.json('GET', '/v1/users/me');
    assert.equal(anon.status, 401);

    const { token } = await h.makeUser('plain', ['user']);
    const ok = await h.json('GET', '/v1/users/me', { token });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.handle, 'plain');
  } finally {
    await h.close();
  }
});

test('authZ matrix: creating a seek requires auth, listing is public', async () => {
  const h = await startHarness();
  try {
    const anonCreate = await h.json('POST', '/v1/seeks', {
      body: { variant: 'standard', timeControl: { initialMs: 180000, incrementMs: 2000, delayMs: 0, kind: 'increment' } },
    });
    assert.equal(anonCreate.status, 401);

    const { token } = await h.makeUser('seeker', ['user']);
    const create = await h.json('POST', '/v1/seeks', {
      token,
      body: { variant: 'standard', timeControl: { initialMs: 180000, incrementMs: 2000, delayMs: 0, kind: 'increment' } },
    });
    assert.equal(create.status, 201);

    const list = await h.json('GET', '/v1/seeks');
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
  } finally {
    await h.close();
  }
});

test('authZ matrix: seek cancellation is owner-or-moderator', async () => {
  const h = await startHarness();
  try {
    const owner = await h.makeUser('owner', ['user']);
    const stranger = await h.makeUser('stranger', ['user']);
    const mod = await h.makeUser('mod', ['moderator']);

    const tc = { initialMs: 180000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' as const };

    // A non-owner plain user cannot cancel.
    const s1 = await h.json('POST', '/v1/seeks', { token: owner.token, body: { variant: 'atomic', timeControl: tc } });
    const strangerDelete = await h.json('DELETE', `/v1/seeks/${s1.body.id}`, { token: stranger.token });
    assert.equal(strangerDelete.status, 403);

    // The owner can cancel their own.
    const ownerDelete = await h.json('DELETE', `/v1/seeks/${s1.body.id}`, { token: owner.token });
    assert.equal(ownerDelete.status, 204);

    // A moderator can cancel someone else's.
    const s2 = await h.json('POST', '/v1/seeks', { token: owner.token, body: { variant: 'atomic', timeControl: tc } });
    const modDelete = await h.json('DELETE', `/v1/seeks/${s2.body.id}`, { token: mod.token });
    assert.equal(modDelete.status, 204);

    // Cancelling a missing seek is 404.
    const missing = await h.json('DELETE', `/v1/seeks/${s2.body.id}`, { token: mod.token });
    assert.equal(missing.status, 404);
  } finally {
    await h.close();
  }
});
