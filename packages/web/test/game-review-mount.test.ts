import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/composition.js';
import { mountGame } from '../src/app/game-mount.js';
import type { GameReviewResponse } from '../src/api/models.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../src/ports/http.js';
import { AsyncTransport, createGameDocument, makeFinishedState } from './support/analysis-fixtures.js';
import type { FakeElement } from './support/analysis-fixtures.js';
import { FakeSocketFactory } from './support/fake-socket.js';
import { json } from './support/fake-transport.js';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const COMPLETED_REVIEW: GameReviewResponse = {
  gameId: 'g-test-1',
  variant: 'standard',
  playerColor: 'white',
  result: '1-0',
  termination: 'checkmate',
  moves: [],
  summary: {
    brilliant: 0,
    great: 0,
    best: 1,
    excellent: 0,
    good: 0,
    book: 0,
    inaccuracy: 0,
    mistake: 0,
    miss: 0,
    blunder: 0,
    missed_win: 0,
  },
};

interface PendingReview {
  readonly request: HttpRequest;
  readonly resolve: (response: HttpResponse) => void;
}

function setup(variant = 'standard', gameReviewVariants: readonly string[] = ['standard']) {
  const pendingReviews: PendingReview[] = [];
  const transport: HttpTransport = new AsyncTransport((request) => {
    if (request.url.endsWith('/v1/capabilities')) {
      return json(200, { capabilities: { gameReview: true }, gameReviewVariants });
    }
    if (request.url.endsWith('/v1/games/g-test-1/review')) {
      return new Promise<HttpResponse>((resolve) => pendingReviews.push({ request, resolve }));
    }
    return json(404, {});
  });
  const sockets = new FakeSocketFactory();
  const app = createApp({
    config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' },
    httpTransport: transport,
    wsFactory: sockets.factory,
  });
  app.api.session.adopt({
    user: { id: 'user-1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
    tokens: { accessToken: 'token', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
  });
  const { doc, elements } = createGameDocument();
  const mounted = mountGame({
    doc,
    boardEl: elements.get('board')! as unknown as HTMLElement,
    gameId: 'g-test-1',
    createGameSync: app.createGameSync,
    createGameOracle: app.createGameOracle,
    getAccessToken: () => app.api.session.current?.tokens.accessToken,
    client: app.api,
    token: 'token',
    initialSessionId: 'user-1',
    restorePromise: Promise.resolve(null),
  });
  sockets.last.open();
  sockets.last.emit({
    t: 'joined',
    gameId: 'g-test-1',
    role: 'white',
    state: { ...makeFinishedState(FEN), variant },
  });

  return { app, elements, mounted, pendingReviews };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  assert.fail('condition did not become true while draining queued work');
}

function runReview(elements: Map<string, FakeElement>): void {
  elements.get('game-review-run')!.click();
}

function dispose(setupResult: ReturnType<typeof setup>): void {
  setupResult.mounted.analysis.dispose();
  setupResult.mounted.connectivity.dispose();
  setupResult.mounted.controller.dispose();
  setupResult.app.dispose();
}

test('sign-out removes a completed private review from the mounted page', async () => {
  const mountedGame = setup();
  try {
    await waitUntil(() => mountedGame.elements.get('game-review-run')!.disabled === false);
    runReview(mountedGame.elements);
    await waitUntil(() => mountedGame.pendingReviews.length === 1);
    mountedGame.pendingReviews[0]!.resolve(json(200, COMPLETED_REVIEW));
    await waitUntil(() => mountedGame.elements.get('game-review-summary')!.hidden === false);

    const summary = mountedGame.elements.get('game-review-summary')!;
    assert.equal(summary.hidden, false);
    assert.equal(summary.childElementCount, 11);

    mountedGame.mounted.onSessionChange(null);

    assert.equal(summary.hidden, true);
    assert.equal(summary.childElementCount, 0);
    assert.equal(mountedGame.elements.get('game-review-moves')!.childElementCount, 0);
    assert.equal(mountedGame.elements.get('game-review-note')!.textContent, 'Sign in to review your game.');
  } finally {
    dispose(mountedGame);
  }
});

test('sign-out aborts an in-flight review and a late response cannot repopulate the page', async () => {
  const mountedGame = setup();
  try {
    await waitUntil(() => mountedGame.elements.get('game-review-run')!.disabled === false);
    runReview(mountedGame.elements);
    await waitUntil(() => mountedGame.pendingReviews.length === 1);
    const pending = mountedGame.pendingReviews[0]!;

    mountedGame.mounted.onSessionChange(null);

    assert.equal(pending.request.signal?.aborted, true);
    assert.equal(mountedGame.elements.get('game-review-summary')!.hidden, true);
    pending.resolve(json(200, COMPLETED_REVIEW));
    await settle();
    assert.equal(mountedGame.elements.get('game-review-summary')!.hidden, true);
    assert.equal(mountedGame.elements.get('game-review-summary')!.childElementCount, 0);
  } finally {
    dispose(mountedGame);
  }
});

test('a completed game with an unsupported variant never offers Game Review', async () => {
  const mountedGame = setup('atomic', ['standard']);
  try {
    await settle();
    assert.equal(mountedGame.elements.get('game-review')!.hidden, true);
    assert.equal(mountedGame.elements.get('game-review-run')!.disabled, true);
    mountedGame.elements.get('game-review-run')!.click();
    assert.equal(mountedGame.pendingReviews.length, 0);
  } finally {
    dispose(mountedGame);
  }
});
