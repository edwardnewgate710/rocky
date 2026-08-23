/**
 * Tournament commentary route tests (ADR-0130).
 *
 * The service tests cover what a commentary says; these cover who may ask for one, what it costs,
 * and what the endpoint refuses to accept. Two of them are the reason the routes have this shape:
 * the one proving an anonymous caller cannot spend a provider budget, and the one proving a caller
 * cannot smuggle their own tournament facts past a server that is supposed to derive all of them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  AnalysisProvider,
  AnalysisRequest,
  EngineCapabilities,
  EngineResult,
  PlayRequest,
  PlayResult,
} from '@chess-platform/engine';
import type { CompletionPort, CompletionRequest, CompletionResponse } from '@chess-platform/ai-orchestrator';
import { TournamentCommentator } from '@chess-platform/ai-features';
import { Tournament, createPairingStrategy } from '@chess-platform/tournament';
import type { RoundBasedConfig } from '@chess-platform/tournament';

import { AnalysisService } from '../src/analysis/service.js';
import { DEFAULT_RATE_LIMIT } from '../src/config.js';
import { TournamentCommentaryService } from '../src/commentary/tournament-commentary-service.js';
import type { PlayerHandles, TournamentFacts, TournamentLookup, TournamentLookupFailure } from '../src/commentary/ports.js';
import type { FinishedGame, FinishedGameArchive } from '../src/tournament/finished-game.js';
import { startHarness } from './helpers.js';

/** The position after 1.e4 e5 2.Nf3, from which 2...Nc6 is the final move of the fixture game. */
const BEFORE_FINAL = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';

class StubProvider implements AnalysisProvider {
  readonly requests: AnalysisRequest[] = [];

  /**
   * @param request - recorded so the cost assertions can read what the engine was actually asked.
   * @returns one flat line; these tests are about access and cost, not chess.
   */
  async analyze(request: AnalysisRequest): Promise<readonly EngineResult[]> {
    this.requests.push(request);
    return [
      {
        multipv: 1,
        evaluation: { type: 'cp' as const, value: 18 },
        principalVariation: ['b8c6', 'f1b5'],
        depth: 18,
        nodes: 1000,
        nps: 100000,
        timeMs: 10,
      },
    ];
  }

  /** Never reached: commentary only ever analyses. Throwing says so rather than returning a lie. */
  async play(_request: PlayRequest): Promise<PlayResult> {
    throw new Error('not used');
  }

  /** @returns `undefined`: the stub declares no engine capabilities, so nothing is narrowed. */
  capabilitiesFor(_variant: string): EngineCapabilities | undefined {
    return undefined;
  }
}

class StubCompletions implements CompletionPort {
  readonly requests: CompletionRequest[] = [];

  /**
   * @param request - recorded so the tests can read exactly what was sent to a third party.
   * @returns a canned completion.
   */
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(request);
    return {
      content: 'A sharp opening choice, and the engine likes White by a shade.',
      providerId: 'stub',
      model: 'stub-1',
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      latencyMs: 1,
      finishReason: 'stop',
      costMicroUsd: 0,
      cached: false,
    };
  }
}

/** An engine the library must never reach; reaching it fails the test that let it happen. */
class RefusingEngine implements AnalysisProvider {
  /** @throws always — a call here is the library choosing its own search limits. */
  async analyze(_request: AnalysisRequest): Promise<readonly EngineResult[]> {
    throw new Error('the library searched on its own');
  }

  /** @throws always — commentary never asks an engine for a move. */
  async play(_request: PlayRequest): Promise<PlayResult> {
    throw new Error('not used');
  }

  /** @returns `undefined`; this double declares no capabilities. */
  capabilitiesFor(_variant: string): EngineCapabilities | undefined {
    return undefined;
  }
}

const WHITE_ID = '11111111-1111-4111-8111-111111111111';
const BLACK_ID = '22222222-2222-4222-8222-222222222222';
const THIRD_ID = '33333333-3333-4333-8333-333333333333';
const FOURTH_ID = '44444444-4444-4444-8444-444444444444';
const GAME_ID = 'game-1';

const SWISS: RoundBasedConfig = {
  id: 't1',
  name: 'Test Open',
  format: 'swiss',
  variant: 'standard',
  timeControl: { initialMs: 300_000, incrementMs: 3_000, delayMs: 0, kind: 'increment' },
  rounds: 3,
};

/**
 * Two players, one linked game, and round 0 decided.
 *
 * Round 0 is completed deliberately: a recap of an unfinished round is refused *before* the quota
 * is charged, so a test that used one to probe the shared bucket would be measuring the validation
 * order instead of the bucket. That is the right order, and it is why this fixture has to be valid.
 */
function fixtureTournament(): Tournament {
  const tournament = new Tournament(SWISS, createPairingStrategy(SWISS));
  for (const player of [WHITE_ID, BLACK_ID, THIRD_ID, FOURTH_ID]) tournament.register(player);
  tournament.start();
  tournament.linkGame(0, 0, GAME_ID);

  // Three complete rounds, each decided a different way, and the recap asks for the *middle* one.
  // Two rounds was not enough: round 1 was then the final round, so "the table after round 1" and
  // "the table now" were the same table and a projection ignoring the requested round passed.
  // Raised twice in the CodeRabbit review of PR #153 — once for asking round 0 of a one-round
  // fixture, and again for asking the last round of a two-round one.
  //
  // Four players is the smallest field Swiss can pair three times: it will not rematch.
  for (const [round, result] of [[0, 'white_win'], [1, 'black_win'], [2, 'draw']] as const) {
    for (let p = 0; p < tournament.getRounds()[round]!.pairings.length; p += 1) {
      tournament.recordResult(round, p, result);
    }
  }
  return tournament;
}

const FINISHED: FinishedGame = {
  gameId: GAME_ID,
  variant: 'standard',
  white: WHITE_ID,
  black: BLACK_ID,
  result: '1-0',
  termination: 'resign',
  ply: 3,
  finalFen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
  finalMove: { uci: 'b8c6', san: 'Nc6', by: 'b' },
  fenBeforeFinalMove: BEFORE_FINAL,
};

interface Wiring {
  readonly service: TournamentCommentaryService;
  readonly provider: StubProvider;
  readonly completions: StubCompletions;
}

/**
 * Build the service over doubles the test controls.
 *
 * @param overrides - archive and lookup substitutions for the refusal cases.
 * @returns the service and the two recorders the assertions read.
 */
function wire(overrides: {
  readonly archive?: FinishedGameArchive;
  readonly lookup?: TournamentLookup;
} = {}): Wiring {
  const provider = new StubProvider();
  const completions = new StubCompletions();
  const tournament = fixtureTournament();

  const lookup: TournamentLookup = overrides.lookup ?? {
    /** @returns the fixture tournament, whose round 0 is complete and linked to {@link GAME_ID}. */
    async roundBased(): Promise<TournamentFacts | TournamentLookupFailure> {
      return tournament;
    },
  };
  const archive: FinishedGameArchive = overrides.archive ?? {
    /** @returns the finished fixture game. */
    async finishedGame(): Promise<FinishedGame | undefined> {
      return FINISHED;
    },
  };
  const players: PlayerHandles = {
    /** @returns a handle for every fixture player, so the standings rows are named not numbered. */
    async handles(): Promise<ReadonlyMap<string, string>> {
      return new Map([
        [WHITE_ID, 'alice'],
        [BLACK_ID, 'bob'],
        [THIRD_ID, 'carol'],
        [FOURTH_ID, 'dave'],
      ]);
    },
  };

  const service = new TournamentCommentaryService({
    analysis: new AnalysisService({ provider }),
    commentator: new TournamentCommentator({
      engine: new RefusingEngine(),
      ai: completions,
      temperature: 0.6,
      maxTokens: 512,
    }),
    archive,
    tournaments: lookup,
    players,
  });
  return { service, provider, completions };
}

test('commentary requires an account, so no anonymous caller can spend a provider budget', async () => {
  const { service, provider, completions } = wire();
  const h = await startHarness({}, { tournamentCommentary: service });
  try {
    const anonymous = await h.json('POST', `/v1/tournaments/t1/games/${GAME_ID}/commentary`);
    assert.equal(anonymous.status, 401);
    const anonymousRecap = await h.json('POST', '/v1/tournaments/t1/rounds/0/recap');
    assert.equal(anonymousRecap.status, 401);

    // The header, not just the status, and that is the whole point of asserting it. `requireAuth`
    // in the handler answers 401 on its own, so a route declared PUBLIC would still refuse an
    // anonymous caller — and would silently stop sending the challenge the router adds for an
    // AUTHED route. Found by a mutation that flipped both declarations to PUBLIC and survived.
    assert.equal(anonymous.headers.get('www-authenticate'), 'Bearer');
    assert.equal(anonymousRecap.headers.get('www-authenticate'), 'Bearer');

    // The refusal happens above the service, so neither subsystem was touched at all. Asserting the
    // 401 alone would pass just as well if the engine ran first and the answer were thrown away.
    assert.equal(provider.requests.length, 0);
    assert.equal(completions.requests.length, 0);

    const user = await h.makeUser('spectator');
    const res = await h.json('POST', `/v1/tournaments/t1/games/${GAME_ID}/commentary`, {
      token: user.token,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.white, 'alice');
    assert.equal(res.body.black, 'bob');
    assert.equal(res.body.commentary, 'A sharp opening choice, and the engine likes White by a shade.');
  } finally {
    await h.close();
  }
});

test('the caller may not supply tournament facts, and is told rather than ignored', async () => {
  const { service, completions } = wire();
  const h = await startHarness({}, { tournamentCommentary: service });
  try {
    const user = await h.makeUser('fabricator');

    // Each of these is a fact the server derives. A body that could carry them is a body that could
    // put a game nobody played, or a result nobody achieved, into a narrative that reads as
    // official. `strictObject` refuses the request outright rather than dropping the field.
    for (const body of [
      { fen: '8/8/8/8/8/8/8/K6k w - - 0 1' },
      { results: [{ white: 'me', black: 'you', result: '1-0' }] },
      { standings: [{ rank: 1, player: 'me', points: 99 }] },
      { white: 'magnus' },
      { depth: 40 },
      { model: 'gpt-4' },
      // An empty object and an explicit null are bodies too. Both were accepted until the CodeRabbit
      // review of PR #153 pointed out that the documented response for a request body is 422, so a
      // 200 for either was the contract disagreeing with itself.
      {},
      null,
    ]) {
      // Both routes, not just the recap. They call `noBody` separately, so a test that exercised
      // one would leave the other free to accept caller-supplied fields — an edit removing that call
      // from the commentary handler passed the whole suite until this loop covered it. Raised in the
      // CodeRabbit review of PR #153.
      for (const path of [
        '/v1/tournaments/t1/rounds/0/recap',
        `/v1/tournaments/t1/games/${GAME_ID}/commentary`,
      ]) {
        const res = await h.json('POST', path, { token: user.token, body });
        assert.equal(
          res.status,
          422,
          `${path} accepted ${JSON.stringify(body)}`,
        );
      }
    }

    // And nothing was generated from any of them.
    assert.equal(completions.requests.length, 0);
  } finally {
    await h.close();
  }
});

test('an unconfigured deployment answers 503 rather than a commentary with nothing behind it', async () => {
  const h = await startHarness({}, {});
  try {
    const user = await h.makeUser('hopeful');
    const commentary = await h.json('POST', `/v1/tournaments/t1/games/${GAME_ID}/commentary`, {
      token: user.token,
    });
    assert.equal(commentary.status, 503);
    const recap = await h.json('POST', '/v1/tournaments/t1/rounds/0/recap', { token: user.token });
    assert.equal(recap.status, 503);

    const caps = await h.json('GET', '/v1/capabilities');
    assert.equal(caps.body.capabilities.tournamentCommentary, false);
  } finally {
    await h.close();
  }
});

test('commentary has its own quota, and an unfinished game is refused without spending it', async () => {
  const { service, provider, completions } = wire({
    archive: {
      /** @returns `undefined` — the game is still being played. */
      async finishedGame(): Promise<FinishedGame | undefined> {
        return undefined;
      },
    },
  });
  const h = await startHarness(
    {
      rateLimit: {
        ...DEFAULT_RATE_LIMIT,
        tournamentCommentary: {
          perUser: { maxRequests: 2, windowMs: 60_000 },
          perIp: { maxRequests: 10, windowMs: 60_000 },
        },
      },
    },
    { tournamentCommentary: service },
  );
  try {
    const user = await h.makeUser('persistent');

    // Three requests against a two-request budget. All three are refused for being about a game
    // that is still being played, and none of them is charged — so the budget survives.
    for (let i = 0; i < 3; i += 1) {
      const res = await h.json('POST', `/v1/tournaments/t1/games/${GAME_ID}/commentary`, {
        token: user.token,
      });
      assert.equal(res.status, 409, 'an unfinished game must be refused, not commentated');
    }
    assert.equal(provider.requests.length, 0);
    assert.equal(completions.requests.length, 0);
  } finally {
    await h.close();
  }
});

test('the quota is spent by accepted requests, and refuses the one past it', async () => {
  const { service } = wire();
  const h = await startHarness(
    {
      rateLimit: {
        ...DEFAULT_RATE_LIMIT,
        tournamentCommentary: {
          perUser: { maxRequests: 2, windowMs: 60_000 },
          perIp: { maxRequests: 10, windowMs: 60_000 },
        },
        // Deliberately generous. If commentary charged the analysis bucket as well as its own, the
        // third request would still be refused and this test would pass for the wrong reason; a
        // large ceiling here means only the commentary bucket can be the one that ran out.
        analysis: { perUser: { maxRequests: 100, windowMs: 60_000 }, perIp: { maxRequests: 100, windowMs: 60_000 } },
      },
    },
    { tournamentCommentary: service },
  );
  try {
    const user = await h.makeUser('regular');
    const path = `/v1/tournaments/t1/games/${GAME_ID}/commentary`;
    assert.equal((await h.json('POST', path, { token: user.token })).status, 200);
    assert.equal((await h.json('POST', path, { token: user.token })).status, 200);
    const refused = await h.json('POST', path, { token: user.token });
    assert.equal(refused.status, 429);

    // The recap shares the bucket, so the same minute is already spent for it too.
    const recap = await h.json('POST', '/v1/tournaments/t1/rounds/0/recap', { token: user.token });
    assert.equal(recap.status, 429);
  } finally {
    await h.close();
  }
});

test('a malformed round index is refused before anything is loaded', async () => {
  const { service, completions } = wire({
    lookup: {
      /** @throws if reached — the round index should be refused before any load. */
      async roundBased(): Promise<TournamentFacts | TournamentLookupFailure> {
        throw new Error('the tournament was loaded for a round index that is not a number');
      },
    },
  });
  const h = await startHarness({}, { tournamentCommentary: service });
  try {
    const user = await h.makeUser('fuzzer');
    for (const index of ['abc', '-1', '1.5', '1e3', '01x']) {
      const res = await h.json('POST', `/v1/tournaments/t1/rounds/${index}/recap`, {
        token: user.token,
      });
      assert.equal(res.status, 422, `round index ${JSON.stringify(index)} produced ${res.status}`);
    }
    assert.equal(completions.requests.length, 0);
  } finally {
    await h.close();
  }
});

test('a recap answers with the round facts and the narrative, each in its own field', async () => {
  const { service, provider, completions } = wire();
  const h = await startHarness({}, { tournamentCommentary: service });
  try {
    const user = await h.makeUser('reader');
    // Round 1, not round 0. Both rounds are complete and decided opposite ways, so a handler that
    // always loaded round 0 — or a projection that returned the wrong snapshot — fails here rather
    // than agreeing by coincidence. Raised in the CodeRabbit review of PR #153, on the first version
    // of this test, which asked round 0 of a fixture whose only round was round 0.
    const res = await h.json('POST', '/v1/tournaments/t1/rounds/1/recap', { token: user.token });

    // The only place this file reads a successful recap. Without it the recap route's 200 branch and
    // `tournamentRoundRecapView` are never exercised end to end: a handler returning the *game*
    // view, or a projection that dropped `standings`, would pass every other test here.
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), [
      'model', 'narrative', 'pairingsNarrated', 'providerId', 'results', 'round', 'standings', 'tournamentId',
    ]);
    assert.equal(res.body.round, 1);
    assert.equal(res.body.tournamentId, 't1');

    // Round 1 went to Black in every pairing; round 0 went to White and round 2 was drawn.
    const results = res.body.results as { white: string; black: string; result: string }[];
    assert.equal(results.length, 2);
    for (const pairing of results) assert.equal(pairing.result, 'black_win');
    assert.equal(res.body.pairingsNarrated, 2);

    // The expected table, derived from the pairings this fixture recorded rather than from the
    // aggregate's own answer — a test that asked `standingsAfterRound` what it should say would be
    // agreeing with the code under test. A round-0 white won a point; a round-1 black won a point;
    // round 2 has not happened as far as this recap is concerned.
    const handles = new Map([[WHITE_ID, 'alice'], [BLACK_ID, 'bob'], [THIRD_ID, 'carol'], [FOURTH_ID, 'dave']]);
    const expected = new Map<string, number>([...handles.values()].map((name) => [name, 0]));
    // A second fixture, not the one the service holds: the pairing strategy is deterministic, so
    // this reproduces the same rounds without reaching into the subject under test.
    const rounds = fixtureTournament().getRounds();
    for (const pairing of rounds[0]!.pairings) {
      if (pairing.kind === 'game') expected.set(handles.get(pairing.white)!, expected.get(handles.get(pairing.white)!)! + 1);
    }
    for (const pairing of rounds[1]!.pairings) {
      if (pairing.kind === 'game') expected.set(handles.get(pairing.black)!, expected.get(handles.get(pairing.black)!)! + 1);
    }

    const standings = res.body.standings as { rank: number; player: string; points: number }[];
    assert.equal(standings.length, 4);
    assert.deepEqual(standings.map((row) => row.rank), [1, 2, 3, 4]);

    // The whole mapping, not a lookup per row. Checking each row against its own name leaves a table
    // that lists one player twice and another not at all passing, as long as the two share a score —
    // every row would find its own expected points and the length would still be four. Raised in the
    // CodeRabbit review of PR #153.
    const names = standings.map((row) => row.player);
    assert.equal(new Set(names).size, names.length, `a player appears twice: ${names.join(', ')}`);
    assert.deepEqual(
      [...standings].map((row) => [row.player, row.points]).sort(),
      [...expected.entries()].sort(),
    );

    // Four after two decided rounds; six once round 2's draws are counted. A projection returning
    // the current table rather than the requested round's fails on the total alone.
    assert.equal(standings.reduce((sum, row) => sum + row.points, 0), 4);
    assert.equal(res.body.narrative, 'A sharp opening choice, and the engine likes White by a shade.');

    // A recap runs no search at all — the round's facts come from the aggregate, not an engine.
    assert.equal(provider.requests.length, 0);
    assert.equal(completions.requests.length, 1);
  } finally {
    await h.close();
  }
});
