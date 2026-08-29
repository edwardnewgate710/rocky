import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { chess960Fen } from '@chess-platform/core';
import { fixedChess960Start } from '../src/ports/chess960';
import { startHarness, type Harness } from './helpers';

/**
 * Chess960 must be creatable over HTTP, by the real routes.
 *
 * These go through the routes rather than calling `Game.create` directly, for the same reason the
 * ADR-0123 rejection suite they replace went through them: what matters is what a client that is not
 * the web app — a script, a bot, another front end — can actually do. `OFFERED_VARIANTS` is a
 * client-side convention and was never an invariant, in either direction. ADR-0137.
 */

const TC = { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' } as const;

/**
 * King on d1, rooks on a1 and h1 — visibly not the traditional array.
 *
 * The assertions below name this board rather than "some Chess960 position", because an
 * implementation that accepted the variant and started standard chess anyway would satisfy the
 * weaker claim. Same choice as `packages/game/test/chess960-creation.test.ts`.
 */
const SP700 = 700;
const SP700_FEN = chess960Fen(SP700);
const forced = { chess960Starts: fixedChess960Start(SP700) };

/** The `GameCreated` event actually written to the durable log. */
async function storedCreation(h: Harness, gameId: string) {
  const stored = await h.repos.events.load(gameId);
  const created = stored[0]?.event;
  assert.equal(created?.type, 'GameCreated', 'the first stored event is the creation');
  if (created?.type !== 'GameCreated') throw new Error('unreachable');
  return created;
}

test('a chess960 seek can be opened and accepted into a playable game', async () => {
  const h = await startHarness({}, forced);
  try {
    const creator = await h.makeUser('creator960', ['user']);
    const joiner = await h.makeUser('joiner960', ['user']);

    const seekRes = await h.json('POST', '/v1/seeks', {
      token: creator.token,
      body: { variant: 'chess960', timeControl: TC },
    });
    assert.equal(seekRes.status, 201, 'the seek is accepted, not refused as an uncreatable variant');
    assert.equal(seekRes.body.variant, 'chess960');

    const acceptRes = await h.json('POST', `/v1/seeks/${seekRes.body.id}/accept`, {
      token: joiner.token,
    });
    assert.equal(acceptRes.status, 200, 'acceptance starts a game rather than answering 409');

    const created = await storedCreation(h, acceptRes.body.gameId);
    assert.equal(created.variant, 'chess960');
    assert.equal(created.chess960StartId, SP700, 'the arrangement is recorded on the event');
    assert.equal(created.initialFen, SP700_FEN, 'and the position is the one the id names');
  } finally {
    await h.close();
  }
});

test('the seek itself carries no starting position: it is drawn at acceptance', async () => {
  // A seek is an offer that may never be taken up. Drawing at creation would mint a position for
  // every abandoned seek, and — the deciding half — would publish it in `SeekView`, letting an
  // opponent see the board before choosing whether to accept.
  const h = await startHarness({}, forced);
  try {
    const creator = await h.makeUser('creator960b', ['user']);
    const seekRes = await h.json('POST', '/v1/seeks', {
      token: creator.token,
      body: { variant: 'chess960', timeControl: TC },
    });

    assert.equal(seekRes.status, 201);
    assert.equal(
      JSON.stringify(seekRes.body).includes('chess960StartId'),
      false,
      'no starting position is published on an open seek',
    );
  } finally {
    await h.close();
  }
});

test('a chess960 bot game starts from the arrangement the server drew', async () => {
  const h = await startHarness({}, forced);
  try {
    const user = await h.makeUser('botplayer960', ['user']);

    const res = await h.json('POST', '/v1/games/bot', {
      token: user.token,
      body: { level: 'novice', variant: 'chess960', timeControl: TC },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.variant, 'chess960');

    const created = await storedCreation(h, res.body.id);
    assert.equal(created.chess960StartId, SP700);
    assert.equal(created.initialFen, SP700_FEN);
  } finally {
    await h.close();
  }
});

test('a chess960 tournament can be created', async () => {
  const h = await startHarness({}, forced);
  try {
    const director = await h.makeUser('director960', ['user', 'tournament_director']);

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

    assert.equal(
      res.status,
      201,
      'the tournament launcher reaches Game.create, so this is a creation boundary too',
    );
    assert.equal(res.body.variant, 'chess960');
  } finally {
    await h.close();
  }
});

test('each chess960 game gets its own draw, and records the one it used', async () => {
  // The failure this catches is an id drawn once and reused, which every single-game assertion above
  // would still pass. Runs on the real CSPRNG selector rather than a forced one, so the subject is the
  // production draw; what is asserted is per-game consistency, never a distribution.
  const h = await startHarness();
  try {
    const creator = await h.makeUser('multi-creator', ['user']);
    const joiner = await h.makeUser('multi-joiner', ['user']);

    for (let i = 0; i < 4; i++) {
      const seekRes = await h.json('POST', '/v1/seeks', {
        token: creator.token,
        body: { variant: 'chess960', timeControl: TC },
      });
      const acceptRes = await h.json('POST', `/v1/seeks/${seekRes.body.id}/accept`, {
        token: joiner.token,
      });
      assert.equal(acceptRes.status, 200);

      const created = await storedCreation(h, acceptRes.body.gameId);
      const id = created.chess960StartId;
      assert.ok(
        typeof id === 'number' && Number.isInteger(id) && id >= 0 && id < 960,
        `game ${i} drew a usable id, got ${JSON.stringify(id)}`,
      );
      assert.equal(
        created.initialFen,
        chess960Fen(id),
        `game ${i}: the stored position is the one its stored id names`,
      );
    }
  } finally {
    await h.close();
  }
});

test('a client cannot choose the starting position', async () => {
  // The browser must not become the authority. Both creation routes take a strict body, so an extra
  // field is a validation error rather than something quietly ignored — which is the outcome worth
  // having: dropping it silently would let a client believe it had chosen.
  const h = await startHarness({}, forced);
  try {
    const user = await h.makeUser('fabricator', ['user']);

    const seekRes = await h.json('POST', '/v1/seeks', {
      token: user.token,
      body: { variant: 'chess960', timeControl: TC, chess960StartId: 0 },
    });
    assert.equal(seekRes.status, 422, 'a seek cannot name a starting position');

    const botRes = await h.json('POST', '/v1/games/bot', {
      token: user.token,
      body: { level: 'novice', variant: 'chess960', timeControl: TC, chess960StartId: 0 },
    });
    assert.equal(botRes.status, 422, 'nor can a bot game');
  } finally {
    await h.close();
  }
});

test('every variant still creates games end to end', async () => {
  // Chess960 becoming creatable must not narrow anything else. Checked over HTTP because a mistake in
  // the `CREATABLE_VARIANTS` list would show up here and nowhere in the domain tests.
  const h = await startHarness({}, forced);
  try {
    const creator = await h.makeUser('creator', ['user']);
    const joiner = await h.makeUser('joiner', ['user']);

    for (const variant of [
      'standard', 'chess960', 'atomic', 'crazyhouse',
      'threecheck', 'horde', 'racingkings', 'kingofthehill',
    ]) {
      const seekRes = await h.json('POST', '/v1/seeks', {
        token: creator.token,
        body: { variant, timeControl: TC },
      });
      assert.equal(seekRes.status, 201, `${variant} must still open a seek`);

      const acceptRes = await h.json('POST', `/v1/seeks/${seekRes.body.id}/accept`, { token: joiner.token });
      assert.equal(acceptRes.status, 200, `${variant} must still start a game`);

      const created = await storedCreation(h, acceptRes.body.gameId);
      assert.equal(created.variant, variant, `the stored event must record ${variant}`);
      assert.equal(
        created.chess960StartId,
        variant === 'chess960' ? SP700 : undefined,
        `${variant}: a start id is recorded only where one exists`,
      );
    }
  } finally {
    await h.close();
  }
});

test('an unknown variant is still refused', async () => {
  // `CREATABLE_VARIANTS` gaining an entry must not turn the list into "anything goes".
  const h = await startHarness();
  try {
    const user = await h.makeUser('unknown-variant', ['user']);
    const res = await h.json('POST', '/v1/seeks', {
      token: user.token,
      body: { variant: 'chess961', timeControl: TC },
    });
    assert.equal(res.status, 422);
    assert.match(JSON.stringify(res.body), /variant/, 'the error names the offending field');
  } finally {
    await h.close();
  }
});

test('a stored seek whose variant this server cannot start is refused, not played', async () => {
  // The guard ADR-0123 added for stranded `chess960` seeks, kept after chess960 became creatable
  // because the case that motivated it was never the only one it covers. `seek.variant` is typed
  // `Variant` but read from a database column, and `scripts/check-variant-parity.mjs` exists because
  // the type system does not span the SQL — so a value this build cannot honour arrives here as a
  // well-typed string.
  //
  // Written through the repository, because that is the only way such a row can exist: the creation
  // route validates against `CREATABLE_VARIANTS` and would never store one.
  const h = await startHarness();
  try {
    const creator = await h.makeUser('stranded-creator', ['user']);
    const joiner = await h.makeUser('stranded-joiner', ['user']);

    // With rating limits the acceptor cannot meet, on purpose: both guards apply and the unfixable
    // one has to win. A 403 would name a condition they might go and fix, for a seek that can never
    // start a game whatever their rating.
    const seek = await h.repos.seeks.create({
      id: 'stranded-seek',
      creatorId: creator.userId,
      variant: 'chess961' as never,
      timeControl: TC,
      rated: false,
      minRating: 4000,
    });

    const res = await h.json('POST', `/v1/seeks/${seek.id}/accept`, { token: joiner.token });

    assert.equal(res.status, 409, 'the unfixable reason wins over the rating limit');
    assert.match(JSON.stringify(res.body), /chess961/, 'the message names the offending variant');

    // The assertion that matters: no event carrying an unimplementable variant reached the
    // append-only store.
    assert.equal(res.body.gameId, undefined, 'no game id was returned');
    assert.ok(await h.repos.seeks.findById(seek.id), 'the seek was not consumed by the failed accept');
  } finally {
    await h.close();
  }
});
