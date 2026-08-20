import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { startHarness } from './helpers';

/**
 * Chess960 must not be creatable over HTTP either. ADR-0123.
 *
 * These go through the real routes rather than calling `Game.create` directly, because the point of
 * the increment is that a client which is not the web app — a script, a bot, another front end —
 * cannot do what the lobby refuses to offer. The lobby's `OFFERED_VARIANTS` list is a client-side
 * convention and was never an invariant.
 */

const TC = { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' } as const;

test('a direct API client cannot open a chess960 seek', async () => {
  const h = await startHarness();
  try {
    const user = await h.makeUser('seeker', ['user']);

    const res = await h.json('POST', '/v1/seeks', {
      token: user.token,
      body: { variant: 'chess960', timeControl: TC },
    });

    assert.equal(res.status, 422, 'rejected as a validation error, like any unaccepted value');
    assert.match(JSON.stringify(res.body), /variant/, 'the error names the offending field');

    // And nothing was written. A refusal that still left a row would be the defect wearing a
    // different hat.
    const seeks = await h.repos.seeks.listOpen(50);
    assert.equal(seeks.length, 0, 'no seek was created');
  } finally {
    await h.close();
  }
});

test('a direct API client cannot start a chess960 bot game', async () => {
  const h = await startHarness();
  try {
    const user = await h.makeUser('botplayer', ['user']);

    const res = await h.json('POST', '/v1/games/bot', {
      token: user.token,
      // A real level, so the refusal below is the variant's and not the level's — with an invalid
      // level this route answers 422 before it ever looks at the variant, and the test would pass
      // while proving nothing.
      body: { level: 'novice', variant: 'chess960', timeControl: TC },
    });

    assert.equal(res.status, 422);
    assert.match(JSON.stringify(res.body), /variant/, 'the error names the variant, not some earlier field');
  } finally {
    await h.close();
  }
});

test('a tournament cannot be created for chess960', async () => {
  const h = await startHarness();
  try {
    const director = await h.makeUser('director', ['user', 'tournament_director']);

    const res = await h.json('POST', '/v1/tournaments', {
      token: director.token,
      body: {
        name: 'Nine Sixty Open',
        format: 'round_robin',
        variant: 'chess960',
        timeControl: TC,
        rounds: 3,
      },
    });

    assert.equal(res.status, 422, 'the tournament launcher reaches Game.create, so this is a creation boundary too');
  } finally {
    await h.close();
  }
});

test('a chess960 seek stored before the rule cannot be accepted into a game', async () => {
  // The one path input validation cannot reach: the variant comes from a row, not a request. A
  // seek written before ADR-0123 is still in the table, and without this check it would sail into
  // `Game.create`, whose `GameError` nothing maps to a status — so the acceptor would get a 500 for
  // a seek they did not create. Written through the repository on purpose, because that is the only
  // way such a row can exist now that the route refuses it.
  const h = await startHarness();
  try {
    const creator = await h.makeUser('legacy-creator', ['user']);
    const joiner = await h.makeUser('legacy-joiner', ['user']);

    // With rating limits the acceptor cannot meet, on purpose. Both guards apply, and the
    // unfixable one has to win: answering 403 "rating too low" would name a condition they might
    // go and fix, for a seek that can never start a game whatever their rating.
    const seek = await h.repos.seeks.create({
      id: 'legacy-960-seek',
      creatorId: creator.userId,
      variant: 'chess960',
      timeControl: TC,
      rated: false,
      minRating: 4000,
    });

    const res = await h.json('POST', `/v1/seeks/${seek.id}/accept`, { token: joiner.token });

    assert.equal(
      res.status,
      409,
      'the unfixable reason wins over the 403 the rating limit would otherwise produce',
    );
    assert.match(JSON.stringify(res.body), /chess960/, 'the message says which variant is the problem');

    // And no game came out of it. This is the assertion that matters: the whole point is that no
    // `GameCreated` event carrying chess960 reaches the append-only store.
    assert.equal(res.body.gameId, undefined, 'no game id was returned');
    const stillOpen = await h.repos.seeks.findById(seek.id);
    assert.ok(stillOpen, 'the seek was not consumed by the failed acceptance');
  } finally {
    await h.close();
  }
});

test('the variants that are implemented still create games end to end', async () => {
  // The refusal is one name, not a narrowing. Checked over HTTP because a mistake in the
  // `CREATABLE_VARIANTS` list would show up here and nowhere in the domain tests.
  const h = await startHarness();
  try {
    const creator = await h.makeUser('creator', ['user']);
    const joiner = await h.makeUser('joiner', ['user']);

    for (const variant of ['standard', 'atomic', 'crazyhouse', 'threecheck', 'horde', 'racingkings', 'kingofthehill']) {
      const seekRes = await h.json('POST', '/v1/seeks', {
        token: creator.token,
        body: { variant, timeControl: TC },
      });
      assert.equal(seekRes.status, 201, `${variant} must still open a seek`);

      const acceptRes = await h.json('POST', `/v1/seeks/${seekRes.body.id}/accept`, { token: joiner.token });
      assert.equal(acceptRes.status, 200, `${variant} must still start a game`);

      const stored = await h.repos.events.load(acceptRes.body.gameId);
      const created = stored[0]?.event;
      assert.equal(created?.type, 'GameCreated');
      assert.equal(
        created?.type === 'GameCreated' ? created.variant : undefined,
        variant,
        `the stored event must record ${variant}`,
      );
    }
  } finally {
    await h.close();
  }
});
