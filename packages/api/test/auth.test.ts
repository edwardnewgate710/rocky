import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { startHarness } from './helpers';

test('register issues tokens and grants the base user role', async () => {
  const h = await startHarness();
  try {
    const res = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'alice', password: 'hunter2hunter2' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.handle, 'alice');
    assert.deepEqual(res.body.user.roles, ['user']);
    assert.equal(res.body.tokens.tokenType, 'Bearer');
    assert.ok(res.body.tokens.accessToken);
    assert.ok(res.body.tokens.refreshToken);
    assert.equal(res.body.tokens.expiresIn, 900);
    // Password is stored hashed, never in plaintext.
    const stored = await h.repos.users.getPasswordHash(res.body.user.id);
    assert.ok(stored && stored.startsWith('scrypt$'));
    assert.equal(h.repos.audit.withAction('auth.register').length, 1);
  } finally {
    await h.close();
  }
});

test('duplicate handle is rejected with 409 (case-insensitive)', async () => {
  const h = await startHarness();
  try {
    await h.json('POST', '/v1/auth/register', { body: { handle: 'Bob', password: 'password123' } });
    const dup = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'bob', password: 'password123' },
    });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'conflict');
  } finally {
    await h.close();
  }
});

test('concurrent registration creates one complete account and returns one conflict', async () => {
  const h = await startHarness();
  try {
    const requests = ['RaceUser', 'raceuser'].map((handle) =>
      h.json('POST', '/v1/auth/register', {
        body: { handle, password: 'password123' },
      }));
    const responses = await Promise.all(requests);
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
    const user = await h.repos.users.findByHandle('RACEUSER');
    assert.ok(user);
    assert.ok(await h.repos.users.getPasswordHash(user.id));
    assert.deepEqual(await h.repos.users.rolesOf(user.id), ['user']);
  } finally {
    await h.close();
  }
});

test('invalid registration input is a 422 with details', async () => {
  const h = await startHarness();
  try {
    const res = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'a', password: 'short' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'validation_failed');
    assert.ok(res.body.error.requestId);
  } finally {
    await h.close();
  }
});

test('login succeeds with correct password and fails otherwise', async () => {
  const h = await startHarness();
  try {
    await h.json('POST', '/v1/auth/register', { body: { handle: 'carol', password: 'passw0rd!!' } });
    const ok = await h.json('POST', '/v1/auth/login', {
      body: { handle: 'carol', password: 'passw0rd!!' },
    });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.tokens.accessToken);

    const bad = await h.json('POST', '/v1/auth/login', {
      body: { handle: 'carol', password: 'wrong-password' },
    });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error.code, 'unauthorized');
  } finally {
    await h.close();
  }
});

test('login for an unknown handle is 401 (no user enumeration)', async () => {
  const h = await startHarness();
  try {
    const res = await h.json('POST', '/v1/auth/login', {
      body: { handle: 'ghost', password: 'whatever12' },
    });
    assert.equal(res.status, 401);
  } finally {
    await h.close();
  }
});

test('the access token authorizes /v1/users/me', async () => {
  const h = await startHarness();
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'dave', password: 'passw0rd!!' },
    });
    const me = await h.json('GET', '/v1/users/me', { token: reg.body.tokens.accessToken });
    assert.equal(me.status, 200);
    assert.equal(me.body.handle, 'dave');
  } finally {
    await h.close();
  }
});

test('refresh rotates the token and revokes the old session', async () => {
  const h = await startHarness();
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'erin', password: 'passw0rd!!' },
    });
    const first = reg.body.tokens.refreshToken;
    const rot = await h.json('POST', '/v1/auth/refresh', { body: { refreshToken: first } });
    assert.equal(rot.status, 200);
    assert.notEqual(rot.body.tokens.refreshToken, first);
    assert.ok(rot.body.tokens.accessToken);

    // The old refresh token no longer works.
    const reused = await h.json('POST', '/v1/auth/refresh', { body: { refreshToken: first } });
    assert.equal(reused.status, 401);
  } finally {
    await h.close();
  }
});

test('two concurrent refreshes consume a token at most once', async () => {
  const h = await startHarness();
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'refresh-race', password: 'passw0rd!!' },
    });
    const refreshToken = reg.body.tokens.refreshToken;
    const responses = await Promise.all([
      h.json('POST', '/v1/auth/refresh', { body: { refreshToken } }),
      h.json('POST', '/v1/auth/refresh', { body: { refreshToken } }),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 401]);
  } finally {
    await h.close();
  }
});

test('reusing a rotated refresh token burns the whole session chain', async () => {
  const h = await startHarness();
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'frank', password: 'passw0rd!!' },
    });
    const t0 = reg.body.tokens.refreshToken;
    const r1 = await h.json('POST', '/v1/auth/refresh', { body: { refreshToken: t0 } });
    const t1 = r1.body.tokens.refreshToken; // current, still valid

    // Attacker replays the already-rotated t0 → theft detected.
    const theft = await h.json('POST', '/v1/auth/refresh', { body: { refreshToken: t0 } });
    assert.equal(theft.status, 401);
    assert.equal(h.repos.audit.withAction('auth.refresh.reuse').length, 1);

    // The legitimate current token is now also revoked (chain burned).
    const afterBurn = await h.json('POST', '/v1/auth/refresh', { body: { refreshToken: t1 } });
    assert.equal(afterBurn.status, 401);
  } finally {
    await h.close();
  }
});

test('expired refresh tokens are rejected', async () => {
  const h = await startHarness({ refreshTokenTtlSec: 60 });
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'gail', password: 'passw0rd!!' },
    });
    h.clock.advance(61_000);
    const res = await h.json('POST', '/v1/auth/refresh', {
      body: { refreshToken: reg.body.tokens.refreshToken },
    });
    assert.equal(res.status, 401);
  } finally {
    await h.close();
  }
});

test('logout revokes the session; listing sessions reflects it', async () => {
  const h = await startHarness();
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'hank', password: 'passw0rd!!' },
    });
    const token = reg.body.tokens.accessToken;
    const refresh = reg.body.tokens.refreshToken;

    const list1 = await h.json('GET', '/v1/auth/sessions', { token });
    assert.equal(list1.status, 200);
    assert.equal(list1.body.length, 1);
    assert.equal(list1.body[0].revokedAt, null);

    const out = await h.json('POST', '/v1/auth/logout', { token, body: { refreshToken: refresh } });
    assert.equal(out.status, 204);

    const list2 = await h.json('GET', '/v1/auth/sessions', { token });
    assert.equal(list2.body[0].revokedAt !== null, true);

    const afterLogout = await h.json('POST', '/v1/auth/refresh', { body: { refreshToken: refresh } });
    assert.equal(afterLogout.status, 401);
  } finally {
    await h.close();
  }
});

test('missing/expired access tokens are rejected on protected routes', async () => {
  const h = await startHarness();
  try {
    const anon = await h.json('GET', '/v1/users/me');
    assert.equal(anon.status, 401);
    assert.equal(anon.headers.get('www-authenticate'), 'Bearer');

    const bad = await h.json('GET', '/v1/users/me', { token: 'not-a-real-token' });
    assert.equal(bad.status, 401);
  } finally {
    await h.close();
  }
});
