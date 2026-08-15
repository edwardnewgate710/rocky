import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LobbyController } from '../src/app/lobby-controller.js';
import type { GambitClient } from '../src/api/client.js';
import type { GameSummary, SeekView, Variant } from '../src/api/models.js';

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve: resolvePromise,
  };
}

function makeSeek(overrides: Partial<SeekView> = {}): SeekView {
  return {
    id: 's1',
    creatorId: 'u1',
    variant: 'standard' as Variant,
    speed: 'blitz',
    timeControl: { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' },
    rated: true,
    color: 'random',
    minRating: null,
    maxRating: null,
    createdAt: '2026-01-01T00:00:00Z',
    gameId: null,
    acceptedAt: null,
    ...overrides,
  };
}

function makeFakeClient(seeks: SeekView[] = []) {
  let createCalls: any[] = [];
  let cancelCalls: string[] = [];
  return {
    createCalls,
    cancelCalls,
    seeks: {
      list: async () => seeks,
      create: async (body: any) => {
        createCalls.push(body);
        return makeSeek({ id: 'new-seek', ...body });
      },
      cancel: async (id: string) => {
        cancelCalls.push(id);
      },
      accept: async (id: string) => {
        return makeSeek({ id, gameId: 'g1' });
      },
    },
  };
}

test('refresh fetches seeks and calls onSeeks', async () => {
  const seeks = [makeSeek(), makeSeek({ id: 's2' })];
  const client = makeFakeClient(seeks) as any;
  let received: SeekView[] | null = null;
  let errors: string[] = [];
  const ctrl = new LobbyController({
    client,
    callbacks: {
      onSeeks: (s) => { received = [...s]; },
      onCreatePending: () => {},
      onError: (m) => { errors.push(m); },
    },
  });
  await ctrl.refresh();
  assert.deepEqual((received ?? []).map((s: SeekView) => s.id), ['s1', 's2']);
  assert.equal(errors.length, 0);
});

test('start triggers immediate refresh and sets interval', async () => {
  const seeks = [makeSeek()];
  const client = makeFakeClient(seeks) as any;
  let intervals = 0;
  let cleared = 0;
  let seekLists: number[] = [];
  const ctrl = new LobbyController({
    client,
    callbacks: {
      onSeeks: (s) => { seekLists.push(s.length); },
      onCreatePending: () => {},
      onError: () => {},
    },
    refreshIntervalMs: 1000,
    setInterval: (fn, ms) => { intervals++; return 42 as any; },
    clearInterval: (id) => { cleared++; },
  });
  ctrl.start();
  // Wait for the immediate refresh
  await new Promise(r => setTimeout(r, 50));
  assert.equal(intervals, 1);
  assert.deepEqual(seekLists, [1]);
  ctrl.stop();
  assert.equal(cleared, 1);
});

test('createSeek calls API and refreshes the list', async () => {
  const seeks: SeekView[] = [];
  const client = makeFakeClient(seeks) as any;
  let pendingStates: boolean[] = [];
  const ctrl = new LobbyController({
    client,
    callbacks: {
      onSeeks: () => {},
      onCreatePending: (p) => { pendingStates.push(p); },
      onError: () => {},
    },
  });
  const result = await ctrl.createSeek({
    variant: 'standard',
    timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    rated: false,
  });
  assert.ok(result);
  assert.equal(result!.id, 'new-seek');
  assert.equal(client.createCalls.length, 1);
  assert.equal(client.createCalls[0].variant, 'standard');
  assert.equal(client.createCalls[0].rated, false);
  assert.deepEqual(pendingStates, [true, false]);
});

test('cancelSeek calls API and refreshes', async () => {
  const seeks = [makeSeek({ id: 'target' })];
  const client = makeFakeClient(seeks) as any;
  const ctrl = new LobbyController({
    client,
    callbacks: {
      onSeeks: () => {},
      onCreatePending: () => {},
      onError: () => {},
    },
  });
  const ok = await ctrl.cancelSeek('target');
  assert.equal(ok, true);
  assert.deepEqual(client.cancelCalls, ['target']);
});

test('errors are reported via onError', async () => {
  const client = {
    seeks: {
      list: async () => { throw new Error('network down'); },
      create: async () => { throw new Error('fail'); },
      cancel: async () => { throw new Error('fail'); },
    },
  };
  let errors: string[] = [];
  const ctrl = new LobbyController({
    client: client as any,
    callbacks: {
      onSeeks: () => {},
      onCreatePending: () => {},
      onError: (m) => { errors.push(m); },
    },
  });
  await ctrl.refresh();
  assert.equal(errors.length, 1);
  assert.equal(errors[0], 'network down');
});

test('dispose stops timer and ignores future calls', async () => {
  const client = makeFakeClient([makeSeek()]) as any;
  let scheduled = 0;
  let cleared = 0;
  const ctrl = new LobbyController({
    client,
    callbacks: {
      onSeeks: () => {},
      onCreatePending: () => {},
      onError: () => {},
    },
    setInterval: (fn, ms) => {
      scheduled++;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: (id) => { cleared++; },
  });
  ctrl.start();
  ctrl.dispose();
  ctrl.dispose();
  ctrl.start();
  assert.equal(scheduled, 1);
  assert.equal(cleared, 1);
  // After dispose, refresh should be a no-op
  await ctrl.refresh();
  // createSeek should return null
  const result = await ctrl.createSeek({
    variant: 'standard',
    timeControl: { initialMs: 60000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
  });
  assert.equal(result, null);
});

test('POST-AUD-001: deferred refresh cannot publish after disposal', async () => {
  const pendingSeeks = deferred<SeekView[]>();
  const client = {
    seeks: { list: () => pendingSeeks.promise },
  } as unknown as GambitClient;
  const publishedLists: SeekView[][] = [];
  const matchedGames: string[] = [];
  const errors: string[] = [];
  const ctrl = new LobbyController({
    client,
    callbacks: {
      onSeeks: (seeks) => { publishedLists.push([...seeks]); },
      onCreatePending: () => {},
      onError: (message) => { errors.push(message); },
      onGameMatched: (gameId) => { matchedGames.push(gameId); },
    },
  });

  const refresh = ctrl.refresh();
  ctrl.dispose();
  pendingSeeks.resolve([makeSeek({ gameId: 'stale-game' })]);
  await refresh;

  assert.deepEqual(publishedLists, []);
  assert.deepEqual(matchedGames, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(ctrl.currentSeeks, []);
});

test('POST-AUD-001: deferred seek acceptance cannot match after disposal', async () => {
  const pendingAcceptance = deferred<SeekView>();
  const client = {
    seeks: { accept: () => pendingAcceptance.promise },
  } as unknown as GambitClient;
  const matchedGames: string[] = [];
  const ctrl = new LobbyController({
    client,
    callbacks: {
      onSeeks: () => {},
      onCreatePending: () => {},
      onError: () => {},
      onGameMatched: (gameId) => { matchedGames.push(gameId); },
    },
    isAuthenticated: () => true,
  });

  const acceptance = ctrl.acceptSeek('seek-1');
  ctrl.dispose();
  pendingAcceptance.resolve(makeSeek({ gameId: 'stale-game' }));

  assert.equal(await acceptance, false);
  assert.deepEqual(matchedGames, []);
});

test('POST-AUD-001: deferred bot creation cannot succeed after disposal', async () => {
  const pendingGame = deferred<GameSummary>();
  const client = {
    games: { createVsBot: () => pendingGame.promise },
  } as unknown as GambitClient;
  const ctrl = new LobbyController({
    client,
    callbacks: {
      onSeeks: () => {},
      onCreatePending: () => {},
      onError: () => {},
    },
    isAuthenticated: () => true,
  });

  const creation = ctrl.createBotGame({
    level: 'novice',
    variant: 'standard',
    timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
  });
  ctrl.dispose();
  pendingGame.resolve({
    id: 'stale-bot-game',
    variant: 'standard',
    rated: false,
    speed: 'blitz',
    whiteId: 'u1',
    blackId: 'bot',
    result: null,
    termination: null,
    plyCount: 0,
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: null,
  });

  assert.deepEqual(await creation, { ok: false, message: 'Lobby is no longer active.' });
});

test('currentSeeks returns the last fetched list', async () => {
  const seeks = [makeSeek(), makeSeek({ id: 's2' }), makeSeek({ id: 's3' })];
  const client = makeFakeClient(seeks) as any;
  const ctrl = new LobbyController({
    client,
    callbacks: {
      onSeeks: () => {},
      onCreatePending: () => {},
      onError: () => {},
    },
  });
  await ctrl.refresh();
  assert.equal(ctrl.currentSeeks.length, 3);
});
