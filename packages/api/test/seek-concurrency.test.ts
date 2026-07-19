import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { startHarness } from './helpers';

test('seek acceptance concurrency: only one acceptor wins', async () => {
  const h = await startHarness();
  try {
    const creator = await h.makeUser('creator', ['user']);
    const a = await h.makeUser('player-a', ['user']);
    const b = await h.makeUser('player-b', ['user']);

    // Creator opens a seek
    const seekRes = await h.json('POST', '/v1/seeks', {
      token: creator.token,
      body: { variant: 'standard', timeControl: { initialMs: 180000, incrementMs: 2000, delayMs: 0, kind: 'increment' } },
    });
    assert.equal(seekRes.status, 201);
    const seekId = seekRes.body.id;

    // A and B race to accept the seek
    const [resA, resB] = await Promise.all([
      h.json('POST', `/v1/seeks/${seekId}/accept`, { token: a.token }),
      h.json('POST', `/v1/seeks/${seekId}/accept`, { token: b.token }),
    ]);

    // One succeeds (200), one fails (404 Not Found or 409 Conflict)
    const statuses = [resA.status, resB.status].sort();
    assert.deepEqual(statuses, [200, 404], 'exactly one accept must succeed');

    const successRes = resA.status === 200 ? resA : resB;
    const gameId = successRes.body.gameId;
    assert.ok(gameId, 'the successful response must include the gameId');

    // The game must have been created with the correct players
    const game = await h.repos.games.findById(gameId);
    assert.ok(game);
    const storedEvents = await h.repos.events.load(gameId);
    assert.ok(storedEvents.length > 0);
    assert.ok(storedEvents.every((event) => event.serverTs === h.clock.now()));
  } finally {
    await h.close();
  }
});

test('seek cancellation racing acceptance cannot delete a match receipt', async () => {
  const h = await startHarness();
  try {
    const creator = await h.makeUser('cancel-race-creator', ['user']);
    const acceptor = await h.makeUser('cancel-race-acceptor', ['user']);
    const seekRes = await h.json('POST', '/v1/seeks', {
      token: creator.token,
      body: {
        variant: 'standard',
        timeControl: { initialMs: 180000, incrementMs: 2000, delayMs: 0, kind: 'increment' },
      },
    });
    assert.equal(seekRes.status, 201);

    const seekId = seekRes.body.id;
    const [cancelRes, acceptRes] = await Promise.all([
      h.json('DELETE', `/v1/seeks/${seekId}`, { token: creator.token }),
      h.json('POST', `/v1/seeks/${seekId}/accept`, { token: acceptor.token }),
    ]);

    if (acceptRes.status === 200) {
      assert.equal(cancelRes.status, 404);
      const receipt = await h.repos.seeks.findById(seekId);
      assert.equal(receipt?.gameId, acceptRes.body.gameId);
      assert.ok(await h.repos.games.findById(acceptRes.body.gameId));
    } else {
      assert.equal(acceptRes.status, 404);
      assert.equal(cancelRes.status, 204);
      assert.equal(await h.repos.seeks.findById(seekId), null);
      assert.deepEqual(await h.repos.games.recentForUser(acceptor.userId, 10), []);
    }
  } finally {
    await h.close();
  }
});

test('seek listing keeps the latest creator match receipt outside the open-seek limit', async () => {
  const h = await startHarness();
  try {
    const creatorId = 'creator-id';
    const newSeek = (id: string) =>
      h.repos.seeks.create({
        id,
        creatorId,
        variant: 'standard',
        timeControl: { initialMs: 180000, incrementMs: 2000, delayMs: 0, kind: 'increment' },
        rated: false,
      });

    await newSeek('matched-old');
    h.repos.seeks._claim('matched-old', 'game-old', new Date(h.clock.now()));
    h.clock.advance(1_000);
    await newSeek('matched-latest');
    h.repos.seeks._claim('matched-latest', 'game-latest', new Date(h.clock.now()));
    await newSeek('open-first');
    await newSeek('open-second');

    const rows = await h.repos.seeks.listOpen(1, creatorId);
    assert.deepEqual(rows.map((row) => row.id), ['matched-latest', 'open-first']);
  } finally {
    await h.close();
  }
});
