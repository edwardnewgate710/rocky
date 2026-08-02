import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers';

/** Every `/v1/messages` route. None of them is public, so the list doubles as the auth matrix. */
const ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['GET', '/v1/messages/conversations'],
  ['POST', '/v1/messages/conversations'],
  ['GET', '/v1/messages/conversations/00000000-0000-7000-8000-000000000000'],
  ['GET', '/v1/messages/conversations/00000000-0000-7000-8000-000000000000/messages'],
  ['POST', '/v1/messages/conversations/00000000-0000-7000-8000-000000000000/messages'],
  ['POST', '/v1/messages/conversations/00000000-0000-7000-8000-000000000000/read'],
  ['PATCH', '/v1/messages/messages/00000000-0000-7000-8000-000000000000'],
  ['DELETE', '/v1/messages/messages/00000000-0000-7000-8000-000000000000'],
  ['GET', '/v1/messages/unread-count'],
];

/** `fetch` refuses a body on GET, so the sweep supplies one only where the method allows it. */
function bodyFor(method: string): { body?: Record<string, unknown> } {
  return method === 'GET' ? {} : { body: {} };
}

describe('/v1/messages REST API endpoints', () => {
  it('responds 503 on every route when the messaging repository is missing', async () => {
    const harness = await startHarness({}, { withoutMessaging: true });
    try {
      const { token } = await harness.makeUser('alice');
      for (const [method, path] of ROUTES) {
        const res = await harness.json(method, path, { token, ...bodyFor(method) });
        assert.equal(res.status, 503, `${method} ${path} should be unavailable, got ${res.status}`);
        assert.equal(res.body.error.code, 'service_unavailable');
      }
    } finally {
      await harness.close();
    }
  });

  it('rejects every route without a token', async () => {
    // Named for what it checks. An auth test that spot-checks two of nine routes is exactly how a
    // public route ships by accident: the one nobody listed is the one nobody guards.
    const harness = await startHarness();
    try {
      for (const [method, path] of ROUTES) {
        const res = await harness.json(method, path, bodyFor(method));
        assert.equal(res.status, 401, `${method} ${path} must require auth, got ${res.status}`);
      }
    } finally {
      await harness.close();
    }
  });

  it('supports full messaging lifecycle: open conversation, send, edit, tombstone, mark read, unread count', async () => {
    const harness = await startHarness();
    try {
      const alice = await harness.makeUser('alice');
      const bob = await harness.makeUser('bob');
      const charlie = await harness.makeUser('charlie');

      // 1. Open conversation Alice <-> Bob
      const openRes = await harness.json('POST', '/v1/messages/conversations', {
        token: alice.token,
        body: { playerId: bob.userId },
      });
      assert.equal(openRes.status, 200);
      const convId = openRes.body.id;
      assert.ok(convId);

      // 2. Fetch conversation details by ID
      const getRes = await harness.json('GET', `/v1/messages/conversations/${convId}`, {
        token: alice.token,
      });
      assert.equal(getRes.status, 200);
      assert.equal(getRes.body.id, convId);

      // Non-participant receives 404
      const notFoundRes = await harness.json('GET', `/v1/messages/conversations/${convId}`, {
        token: charlie.token,
      });
      assert.equal(notFoundRes.status, 404);

      // 3. Send message from Alice to Bob
      const sendRes = await harness.json('POST', `/v1/messages/conversations/${convId}/messages`, {
        token: alice.token,
        body: { body: 'Hello Bob!' },
      });
      assert.equal(sendRes.status, 201);
      const msgId = sendRes.body.id;
      assert.equal(sendRes.body.body, 'Hello Bob!');

      // Check unread count for Bob (should be 1)
      const bobUnread = await harness.json('GET', '/v1/messages/unread-count', {
        token: bob.token,
      });
      assert.equal(bobUnread.status, 200);
      assert.equal(bobUnread.body.unreadCount, 1);

      // 4. List messages in thread
      const threadRes = await harness.json('GET', `/v1/messages/conversations/${convId}/messages`, {
        token: bob.token,
      });
      assert.equal(threadRes.status, 200);
      assert.equal(threadRes.body.total, 1);
      assert.equal(threadRes.body.items[0].id, msgId);

      // 5. Mark read for Bob
      const readRes = await harness.json('POST', `/v1/messages/conversations/${convId}/read`, {
        token: bob.token,
      });
      assert.equal(readRes.status, 200);

      // Bob's unread count is now 0
      const bobUnreadAfter = await harness.json('GET', '/v1/messages/unread-count', {
        token: bob.token,
      });
      assert.equal(bobUnreadAfter.body.unreadCount, 0);

      // 6. Edit message by Alice
      const editRes = await harness.json('PATCH', `/v1/messages/messages/${msgId}`, {
        token: alice.token,
        body: { body: 'Hello Bob (edited)!' },
      });
      assert.equal(editRes.status, 200);
      assert.equal(editRes.body.body, 'Hello Bob (edited)!');
      assert.ok(editRes.body.editedAt);

      // Edit by Bob rejected (403). Bob is a participant — he can already read the message, so
      // saying "not yours" tells him nothing new.
      const unauthEdit = await harness.json('PATCH', `/v1/messages/messages/${msgId}`, {
        token: bob.token,
        body: { body: 'Hacked by Bob' },
      });
      assert.equal(unauthEdit.status, 403);

      // Charlie is a stranger, and for him the answer must be 404 — the same answer an id that
      // does not exist gets. A 403 here would be an existence oracle over UUIDv7 ids.
      const inventedId = '00000000-0000-7000-8000-0000000000ff';
      for (const targetId of [msgId, inventedId]) {
        const strangerEdit = await harness.json('PATCH', `/v1/messages/messages/${targetId}`, {
          token: charlie.token,
          body: { body: 'Hacked by Charlie' },
        });
        assert.equal(strangerEdit.status, 404, `PATCH ${targetId} as a stranger must be 404`);

        const strangerDelete = await harness.json('DELETE', `/v1/messages/messages/${targetId}`, {
          token: charlie.token,
        });
        assert.equal(strangerDelete.status, 404, `DELETE ${targetId} as a stranger must be 404`);
      }

      // Marking someone else's conversation read is the same class of question.
      const strangerRead = await harness.json('POST', `/v1/messages/conversations/${convId}/read`, {
        token: charlie.token,
      });
      assert.equal(strangerRead.status, 404);

      // 7. Delete (tombstone) message by Alice
      const deleteRes = await harness.json('DELETE', `/v1/messages/messages/${msgId}`, {
        token: alice.token,
      });
      assert.equal(deleteRes.status, 200);
      assert.equal(deleteRes.body.body, '');
      assert.ok(deleteRes.body.deletedAt);

      // Further edit on deleted message returns 409 Conflict
      const editDeleted = await harness.json('PATCH', `/v1/messages/messages/${msgId}`, {
        token: alice.token,
        body: { body: 'Try edit deleted' },
      });
      assert.equal(editDeleted.status, 409);

      // 8. List conversations
      const convsList = await harness.json('GET', '/v1/messages/conversations', {
        token: alice.token,
      });
      assert.equal(convsList.status, 200);
      assert.equal(convsList.body.total, 1);
    } finally {
      await harness.close();
    }
  });

  it('answers 404, not 500, for a well-formed player id that belongs to nobody', async () => {
    const harness = await startHarness();
    try {
      const alice = await harness.makeUser('alice');
      const res = await harness.json('POST', '/v1/messages/conversations', {
        token: alice.token,
        body: { playerId: '00000000-0000-7000-8000-00000000dead' },
      });
      // Left unchecked this reaches the users foreign key in Postgres and comes back as an
      // unmapped driver error — a 500 for what is really "no such player". The in-memory adapter
      // has no foreign key to hit at all, so the check has to sit at the route for the two to agree.
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });

  it('enforces blocks correctly via 403 Forbidden', async () => {
    const harness = await startHarness();
    try {
      const alice = await harness.makeUser('alice');
      const bob = await harness.makeUser('bob');

      // Alice blocks Bob via social endpoint
      await harness.json('POST', `/v1/social/blocks/${bob.userId}`, {
        token: alice.token,
      });

      // Opening conversation blocked -> 403
      const openRes = await harness.json('POST', '/v1/messages/conversations', {
        token: bob.token,
        body: { playerId: alice.userId },
      });
      assert.equal(openRes.status, 403);
    } finally {
      await harness.close();
    }
  });
});
