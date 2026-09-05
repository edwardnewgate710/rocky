import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SEEK_TTL_MS } from '@chess-platform/persistence';
import { startHarness } from './helpers';

test('abandoned seek expires deterministically and is omitted from listOpen', async () => {
  const h = await startHarness();
  try {
    const creator = await h.makeUser('creator-expire', ['user']);

    const seekRes = await h.json('POST', '/v1/seeks', {
      token: creator.token,
      body: {
        variant: 'standard',
        timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
        rated: false,
      },
    });
    assert.equal(seekRes.status, 201);
    const seekId = seekRes.body.id;

    // Immediately after creation, seek is listed
    const list1 = await h.json('GET', '/v1/seeks');
    assert.equal(list1.status, 200);
    assert.ok(list1.body.some((s: { id: string }) => s.id === seekId));

    // Advance clock past SEEK_TTL_MS
    h.clock.advance(SEEK_TTL_MS + 1_000);

    // After TTL, seek must no longer appear in open seeks
    const list2 = await h.json('GET', '/v1/seeks');
    assert.equal(list2.status, 200);
    assert.ok(!list2.body.some((s: { id: string }) => s.id === seekId), 'expired seek must not be listed');
  } finally {
    await h.close();
  }
});

test('expired seek cannot be accepted', async () => {
  const h = await startHarness();
  try {
    const creator = await h.makeUser('creator-expired-accept', ['user']);
    const acceptor = await h.makeUser('acceptor-expired', ['user']);

    const seekRes = await h.json('POST', '/v1/seeks', {
      token: creator.token,
      body: {
        variant: 'standard',
        timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
        rated: false,
      },
    });
    assert.equal(seekRes.status, 201);
    const seekId = seekRes.body.id;

    // Advance past expiration
    h.clock.advance(SEEK_TTL_MS + 1_000);

    // Acceptor tries to accept the expired seek
    const acceptRes = await h.json('POST', `/v1/seeks/${seekId}/accept`, {
      token: acceptor.token,
    });
    assert.equal(acceptRes.status, 404, 'expired seek accept must return 404');
  } finally {
    await h.close();
  }
});

test('creator is not redirected to an already-ended game', async () => {
  const h = await startHarness();
  try {
    const creator = await h.makeUser('creator-redirect', ['user']);
    const acceptor = await h.makeUser('acceptor-redirect', ['user']);

    // Creator posts seek
    const seekRes = await h.json('POST', '/v1/seeks', {
      token: creator.token,
      body: {
        variant: 'standard',
        timeControl: { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' },
        rated: false,
      },
    });
    assert.equal(seekRes.status, 201);
    const seekId = seekRes.body.id;

    // Acceptor accepts
    const acceptRes = await h.json('POST', `/v1/seeks/${seekId}/accept`, {
      token: acceptor.token,
    });
    assert.equal(acceptRes.status, 200);
    const gameId = acceptRes.body.gameId;

    // While game is active, creator sees the match receipt
    const activeReceipts = await h.json('GET', '/v1/seeks', { token: creator.token });
    assert.equal(activeReceipts.status, 200);
    const matchedActive = activeReceipts.body.find((s: { gameId: string | null }) => s.gameId === gameId);
    assert.ok(matchedActive, 'active game match receipt must be returned to creator');

    // The game finishes (e.g. resigned / checkmated / aborted)
    await h.repos.games.finish(gameId, {
      result: '1-0',
      termination: 'resignation',
      plyCount: 2,
      lastSeq: 2,
      endedAt: new Date(h.clock.now()),
    });

    // Creator polls lobby again: already-ended game must NOT be returned as match receipt
    const endedReceipts = await h.json('GET', '/v1/seeks', { token: creator.token });
    assert.equal(endedReceipts.status, 200);
    const matchedEnded = endedReceipts.body.find((s: { gameId: string | null }) => s.gameId === gameId);
    assert.equal(matchedEnded, undefined, 'creator must not be returned a match receipt for an already-ended game');
  } finally {
    await h.close();
  }
});

test('cleanup purges expired abandoned seeks as well as accepted receipts', async () => {
  const h = await startHarness();
  try {
    const creator = await h.makeUser('creator-cleanup', ['user']);

    const seekRes = await h.json('POST', '/v1/seeks', {
      token: creator.token,
      body: {
        variant: 'standard',
        timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
        rated: false,
      },
    });
    assert.equal(seekRes.status, 201);
    const seekId = seekRes.body.id;

    // Advance clock past seek TTL
    h.clock.advance(SEEK_TTL_MS + 5_000);

    // Run cleanup
    await h.repos.seeks.cleanup(new Date(h.clock.now()));

    // Seek row should be purged from database entirely
    const row = await h.repos.seeks.findById(seekId);
    assert.equal(row, null, 'expired abandoned seek must be purged by cleanup');
  } finally {
    await h.close();
  }
});
