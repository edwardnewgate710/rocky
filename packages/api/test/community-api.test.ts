import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers';

const AUTH_MATRIX_ENDPOINTS: Array<[method: string, path: string]> = [
  ['POST', '/v1/teams'],
  ['PATCH', '/v1/teams/00000000-0000-7000-8000-000000000001'],
  ['POST', '/v1/teams/00000000-0000-7000-8000-000000000001/members'],
  ['DELETE', '/v1/teams/00000000-0000-7000-8000-000000000001/members/00000000-0000-7000-8000-000000000002'],
  ['PATCH', '/v1/teams/00000000-0000-7000-8000-000000000001/members/00000000-0000-7000-8000-000000000002'],
  ['POST', '/v1/teams/00000000-0000-7000-8000-000000000001/transfer-ownership'],
  ['POST', '/v1/teams/00000000-0000-7000-8000-000000000001/join-requests'],
  ['GET', '/v1/teams/00000000-0000-7000-8000-000000000001/join-requests'],
  ['POST', '/v1/teams/00000000-0000-7000-8000-000000000001/join-requests/00000000-0000-7000-8000-000000000003/respond'],
  ['DELETE', '/v1/teams/00000000-0000-7000-8000-000000000001/join-requests/00000000-0000-7000-8000-000000000003'],
  ['POST', '/v1/teams/00000000-0000-7000-8000-000000000001/forum/threads'],
  ['PATCH', '/v1/teams/00000000-0000-7000-8000-000000000001/forum/threads/00000000-0000-7000-8000-000000000004'],
  ['DELETE', '/v1/teams/00000000-0000-7000-8000-000000000001/forum/threads/00000000-0000-7000-8000-000000000004'],
  ['POST', '/v1/teams/00000000-0000-7000-8000-000000000001/forum/threads/00000000-0000-7000-8000-000000000004/posts'],
  ['PATCH', '/v1/forum/posts/00000000-0000-7000-8000-000000000005'],
  ['DELETE', '/v1/forum/posts/00000000-0000-7000-8000-000000000005'],
];

describe('/v1/teams and /v1/forum REST API endpoints', () => {
  it('Auth matrix covers every protected endpoint', async () => {
    const harness = await startHarness();
    try {
      for (const [method, path] of AUTH_MATRIX_ENDPOINTS) {
        const bodyObj = method === 'GET' ? {} : { body: {} };
        const res = await harness.json(method, path, bodyObj);
        assert.equal(res.status, 401, `Expected 401 for unauthenticated ${method} ${path}`);
      }
    } finally {
      await harness.close();
    }
  });

  it('rejects a malformed id at the edge instead of handing it to a UUID column', async () => {
    const harness = await startHarness();
    try {
      const { token } = await harness.makeUser('alice');
      // `/v1/teams/:id` accepts a slug by design, so it must resolve rather than reject. Every other
      // route takes a UUID, and a malformed one has to stop here with a 422 — passed through, it
      // reaches a `uuid` column and comes back as an opaque driver error, which is a 500.
      for (const [method, path] of [
        ['GET', '/v1/teams/not-a-uuid/members'],
        ['PATCH', '/v1/teams/not-a-uuid'],
        ['POST', '/v1/teams/not-a-uuid/forum/threads'],
        ['PATCH', '/v1/forum/posts/not-a-uuid'],
        ['DELETE', '/v1/forum/posts/not-a-uuid'],
      ] as const) {
        const res = await harness.json(method, path, {
          token,
          ...(method === 'GET' ? {} : { body: {} }),
        });
        assert.equal(res.status, 422, `${method} ${path} should be 422, got ${res.status}`);
      }

      // The slug path is the exception, and it must not 404 on a real slug.
      const created = await harness.json('POST', '/v1/teams', {
        token,
        body: { slug: 'slug-lookup-team', name: 'Slug Lookup', description: '', visibility: 'public' },
      });
      assert.equal(created.status, 201);
      const bySlug = await harness.json('GET', '/v1/teams/slug-lookup-team', { token });
      assert.equal(bySlug.status, 200);
      assert.equal(bySlug.body.id, created.body.id);
    } finally {
      await harness.close();
    }
  });

  it('503 Service Unavailable when community repository is unconfigured', async () => {
    const harness = await startHarness({}, { withoutCommunity: true });
    try {
      const alice = await harness.makeUser('Alice');

      const createRes = await harness.json('POST', '/v1/teams', {
        token: alice.token,
        body: { slug: 'team-503', name: 'Team 503', visibility: 'public' },
      });
      assert.equal(createRes.status, 503);

      const listRes = await harness.json('GET', '/v1/teams');
      assert.equal(listRes.status, 503);
    } finally {
      await harness.close();
    }
  });

  it('End-to-end community and forum lifecycle', async () => {
    const harness = await startHarness();
    try {
      const alice = await harness.makeUser('Alice');
      const bob = await harness.makeUser('Bob');
      const charlie = await harness.makeUser('Charlie');
      const nonExistentPlayerId = '00000000-0000-7000-8000-000000000099';

      // 1. Create public team (Alice is owner)
      const pubRes = await harness.json('POST', '/v1/teams', {
        token: alice.token,
        body: { slug: 'chess-masters', name: 'Chess Masters', description: 'Public team', visibility: 'public' },
      });
      assert.equal(pubRes.status, 201);
      const pubTeam = pubRes.body;
      assert.equal(pubTeam.slug, 'chess-masters');
      assert.equal(pubTeam.createdBy, alice.userId);

      // Create private team
      const privRes = await harness.json('POST', '/v1/teams', {
        token: alice.token,
        body: { slug: 'secret-club', name: 'Secret Club', description: 'Private team', visibility: 'private' },
      });
      assert.equal(privRes.status, 201);
      const privTeam = privRes.body;

      // 2. GET /v1/teams by ID or slug
      const getBySlug = await harness.json('GET', '/v1/teams/chess-masters');
      assert.equal(getBySlug.status, 200);
      assert.equal(getBySlug.body.id, pubTeam.id);

      // GET private team as stranger (Bob) returns 404
      const getPrivStranger = await harness.json('GET', `/v1/teams/${privTeam.id}`, {
        token: bob.token,
      });
      assert.equal(getPrivStranger.status, 404);

      // 3. Join public team (Bob joins)
      const joinPub = await harness.json('POST', `/v1/teams/${pubTeam.id}/members`, {
        token: bob.token,
      });
      assert.equal(joinPub.status, 201);
      assert.equal(joinPub.body.role, 'member');

      // 4. Missing player existence checks (ADR-0068 §9)
      const nonExistentRemove = await harness.json(
        'DELETE',
        `/v1/teams/${pubTeam.id}/members/${nonExistentPlayerId}`,
        { token: alice.token }
      );
      assert.equal(nonExistentRemove.status, 404);

      const nonExistentRole = await harness.json(
        'PATCH',
        `/v1/teams/${pubTeam.id}/members/${nonExistentPlayerId}`,
        {
          token: alice.token,
          body: { role: 'admin' },
        }
      );
      assert.equal(nonExistentRole.status, 404);

      const nonExistentTransfer = await harness.json(
        'POST',
        `/v1/teams/${pubTeam.id}/transfer-ownership`,
        {
          token: alice.token,
          body: { newOwnerId: nonExistentPlayerId },
        }
      );
      assert.equal(nonExistentTransfer.status, 404);

      // 5. Update role & transfer ownership
      const promoteBob = await harness.json('PATCH', `/v1/teams/${pubTeam.id}/members/${bob.userId}`, {
        token: alice.token,
        body: { role: 'admin' },
      });
      assert.equal(promoteBob.status, 200);

      const transferOwnership = await harness.json('POST', `/v1/teams/${pubTeam.id}/transfer-ownership`, {
        token: alice.token,
        body: { newOwnerId: bob.userId },
      });
      assert.equal(transferOwnership.status, 200);
      assert.equal(transferOwnership.body.newOwner.role, 'owner');

      // 6. Join request lifecycle for private team
      const createReq = await harness.json('POST', `/v1/teams/${privTeam.id}/join-requests`, {
        token: charlie.token,
      });
      assert.equal(createReq.status, 201);
      const reqId = createReq.body.id;

      // Alice (owner of private team) views join requests
      const listReqs = await harness.json('GET', `/v1/teams/${privTeam.id}/join-requests`, {
        token: alice.token,
      });
      assert.equal(listReqs.status, 200);
      assert.equal(listReqs.body.total, 1);

      // Alice accepts request
      const respondReq = await harness.json('POST', `/v1/teams/${privTeam.id}/join-requests/${reqId}/respond`, {
        token: alice.token,
        body: { status: 'accepted' },
      });
      assert.equal(respondReq.status, 200);
      assert.equal(respondReq.body.status, 'accepted');

      // Now Charlie is a member of private team and can GET private team details
      const getPrivMember = await harness.json('GET', `/v1/teams/${privTeam.id}`, {
        token: charlie.token,
      });
      assert.equal(getPrivMember.status, 200);

      // 7. Forum thread & post lifecycle
      const createThreadRes = await harness.json('POST', `/v1/teams/${pubTeam.id}/forum/threads`, {
        token: bob.token,
        body: { title: 'Tournament Tactics', body: 'Share your favorite openings' },
      });
      assert.equal(createThreadRes.status, 201);
      const threadId = createThreadRes.body.thread.id;

      // Post reply
      const createPostRes = await harness.json('POST', `/v1/teams/${pubTeam.id}/forum/threads/${threadId}/posts`, {
        token: alice.token,
        body: { body: 'I prefer Sicilian Defense' },
      });
      assert.equal(createPostRes.status, 201);
      const postId = createPostRes.body.id;

      // Alice edits her post
      const editPostRes = await harness.json('PATCH', `/v1/forum/posts/${postId}`, {
        token: alice.token,
        body: { body: 'I prefer Sicilian Defense (Najdorf variation)' },
      });
      assert.equal(editPostRes.status, 200);

      // Bob (non-author) tries to edit Alice's post -> 403 Forbidden (forgery protection)
      const forgeryEdit = await harness.json('PATCH', `/v1/forum/posts/${postId}`, {
        token: bob.token,
        body: { body: 'Bob changed Alice words' },
      });
      assert.equal(forgeryEdit.status, 403);

      // Bob (owner) deletes Alice's post -> 200 OK (moderation)
      const deletePostRes = await harness.json('DELETE', `/v1/forum/posts/${postId}`, {
        token: bob.token,
      });
      assert.equal(deletePostRes.status, 200);
      assert.equal(deletePostRes.body.body, '');
      assert.ok(deletePostRes.body.deletedAt);

      // 8. Pagination verification
      const listThreadsRes = await harness.json('GET', `/v1/teams/${pubTeam.id}/forum/threads?limit=5&offset=0`);
      assert.equal(listThreadsRes.status, 200);
      assert.equal(listThreadsRes.body.total, 1);
    } finally {
      await harness.close();
    }
  });
});
