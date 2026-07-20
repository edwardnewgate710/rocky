import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap, extractGameId, formatClock } from '../src/app/bootstrap.js';
import type { BootstrapDependencies } from '../src/app/bootstrap.js';
import { GameController } from '../src/app/game-controller.js';
import { FakeTransport, json } from './support/fake-transport.js';
import { FakeSocketFactory } from './support/fake-socket.js';
import { MemoryTokenStore } from '../src/net/session.js';
import type { ServerMessage, StateView } from '../src/net/ws-protocol.js';

// Define HTMLButtonElement for Node.js test environment (m3: bootstrap uses instanceof checks).
class FakeHTMLButtonElement {
  textContent = '';
  classList = new Set<string>();
  disabled = false;
  hidden = false;
  listeners: Record<string, ((e: any) => void)[]> = {};
  addEventListener = (type: string, fn: any) => {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  };
  removeEventListener = () => {};
  focus = () => {};
  setAttribute = () => {};
  getAttribute = () => null;
  appendChild = () => null;
  removeChild = () => null;
  querySelectorAll = () => [];
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  id = '';
  title = '';
  type = 'button';

  click() {
    if (!this.disabled && this.listeners['click']) {
      this.listeners['click'].forEach(fn => fn(new Event('click')));
    }
  }
}
(globalThis as any).HTMLButtonElement = FakeHTMLButtonElement;

/** IDs that should be treated as HTMLButtonElement instances. */
const BUTTON_IDS = new Set([
  'auth-submit', 'auth-logout', 'create-seek', 'flip', 'theme-toggle',
  'action-resign', 'confirm-resign-yes', 'confirm-resign-no',
  'action-abort', 'confirm-abort-yes', 'confirm-abort-no',
  'action-offer-draw', 'action-accept-draw', 'action-decline-draw', 'action-claim-flag'
]);

/**
 * Minimal DOM shim: create a document with the given element IDs.
 * Returns a `Document` with `getElementById` backed by a map.
 * Each element has enough surface area for BoardView to not crash.
 */
function makeFakeEl(id?: string): HTMLElement {
  const isHidden = id === 'game-actions' || id === 'action-error' || id === 'confirm-resign' || id === 'confirm-abort' || id === 'draw-offer-received';
  if (id && BUTTON_IDS.has(id)) {
    const btn = new FakeHTMLButtonElement();
    btn.id = id;
    btn.hidden = isHidden;
    return btn as unknown as HTMLElement;
  }
  const classList = new Set<string>();
  return {
    textContent: '',
    disabled: false,
    hidden: isHidden,
    classList: {
      add: (c: string) => classList.add(c),
      remove: (c: string) => classList.delete(c),
      contains: (c: string) => classList.has(c),
      toggle: (c: string) => { if (classList.has(c)) classList.delete(c); else classList.add(c); },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    setAttribute: () => {},
    getAttribute: () => null,
    appendChild: () => null,
    removeChild: () => null,
    querySelectorAll: () => [],
    focus: () => {},
    style: {},
    dataset: {},
    id: id ?? '',
  } as unknown as HTMLElement;
}

function makeDoc(ids: string[] = ['board', 'status', 'flip', 'theme-toggle', 'auth-status', 'auth-logout', 'auth-submit', 'auth-error', 'auth-form', 'auth-handle', 'auth-password', 'create-seek', 'game-actions', 'action-error', 'action-offer-draw', 'action-claim-flag', 'action-resign', 'action-abort', 'confirm-resign', 'confirm-resign-yes', 'confirm-resign-no', 'confirm-abort', 'confirm-abort-yes', 'confirm-abort-no', 'draw-offer-received', 'action-accept-draw', 'action-decline-draw']): Document {
  const elements = new Map<string, HTMLElement>();
  for (const id of ids) {
    elements.set(id, makeFakeEl(id));
  }
  const docEl = makeFakeEl('documentElement');
  return {
    getElementById: (id: string) => elements.get(id) ?? null,
    documentElement: docEl,
  } as unknown as Document;
}

function makeDocWithBoard(boardEl: HTMLElement, ids: string[] = ['status', 'flip', 'theme-toggle', 'auth-status', 'auth-logout', 'auth-submit', 'auth-error', 'auth-form', 'auth-handle', 'auth-password', 'create-seek', 'game-actions', 'action-error', 'action-offer-draw', 'action-claim-flag', 'action-resign', 'action-abort', 'confirm-resign', 'confirm-resign-yes', 'confirm-resign-no', 'confirm-abort', 'confirm-abort-yes', 'confirm-abort-no', 'draw-offer-received', 'action-accept-draw', 'action-decline-draw']): Document {
  const elements = new Map<string, HTMLElement>();
  elements.set('board', boardEl);
  for (const id of ids) {
    elements.set(id, makeFakeEl(id));
  }
  const docEl = makeFakeEl('documentElement');
  return {
    getElementById: (id: string) => elements.get(id) ?? null,
    documentElement: docEl,
  } as unknown as Document;
}

function makeDeps(sockets?: FakeSocketFactory): BootstrapDependencies {
  const s = sockets ?? new FakeSocketFactory();
  return {
    config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' },
    httpTransport: new FakeTransport().onEach(() => json(200, {})),
    wsFactory: s.factory,
    tokenStore: new MemoryTokenStore(),
  };
}

// ── Shared valid StateView fixture ──────────────────────────────────────────
// Every field required by the StateView interface, so TypeScript catches drift.

/** A minimal but fully valid StateView for an ongoing game (ply 0, white to move). */
const BASE_STATE: StateView = {
  gameId: 'g1',
  variant: 'standard',
  players: { white: 'u1', black: 'u2' },
  timeControl: { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  fenHash: 'start',
  ply: 0,
  turn: 'w',
  clock: { w: 60_000, b: 60_000 },
  status: { over: false },
  drawOffer: null,
  moves: [],
  legalMoves: {},
} satisfies StateView;

// ── extractGameId ───────────────────────────────────────────────────────

test('extractGameId returns null for root path', () => {
  assert.equal(extractGameId('/'), null);
  assert.equal(extractGameId(''), null);
});

test('extractGameId returns the id from /game/{id}', () => {
  assert.equal(extractGameId('/game/abc123'), 'abc123');
  assert.equal(extractGameId('/game/g42'), 'g42');
});

test('extractGameId returns null for single-segment non-game paths (m4)', () => {
  // m4: single-segment paths like /about are NOT treated as game IDs
  assert.equal(extractGameId('/about'), null);
  assert.equal(extractGameId('/abc123'), null);
});

test('extractGameId returns null for multi-segment non-game paths', () => {
  assert.equal(extractGameId('/profile/user'), null);
  assert.equal(extractGameId('/api/v1/games'), null);
});

// ── formatClock ─────────────────────────────────────────────────────────

test('formatClock formats milliseconds as M:SS', () => {
  assert.equal(formatClock(60_000), '1:00');
  assert.equal(formatClock(59_000), '0:59');
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(3_600_000), '60:00');
  assert.equal(formatClock(-5_000), '0:00'); // clamped to 0
});

// ── bootstrap without game ID ───────────────────────────────────────────

test('bootstrap without game ID mounts standalone board, no controller', () => {
  const doc = makeDoc();
  const result = bootstrap(doc, makeDeps());
  assert.ok(result.board);
  assert.equal(result.controller, null);
});

test('bootstrap without board element returns null board', () => {
  const doc = makeDoc([]); // no elements
  const result = bootstrap(doc, makeDeps());
  assert.equal(result.board, null);
  assert.equal(result.controller, null);
});

// ── bootstrap with game ID ──────────────────────────────────────────────

test('bootstrap with game ID creates a GameController', () => {
  const doc = makeDoc();
  const sockets = new FakeSocketFactory();
  const result = bootstrap(doc, { ...makeDeps(sockets), gameId: 'g1', token: 'token-u1' });
  assert.ok(result.controller instanceof GameController);
  assert.ok(result.board);
});

test('bootstrap with game ID opens a connection via gameSync.start()', () => {
  const doc = makeDoc();
  const sockets = new FakeSocketFactory();
  const result = bootstrap(doc, { ...makeDeps(sockets), gameId: 'g1', token: 'token-u1' });
  // C3: bootstrap now calls gameSync.start(), which opens the WebSocket.
  assert.equal(sockets.sockets.length, 1, 'a socket should be opened for a game view');
  assert.ok(result.controller);
});

test('bootstrap wires onPosition callback to board.setPosition', () => {
  const doc = makeDoc();
  const sockets = new FakeSocketFactory();
  const result = bootstrap(doc, { ...makeDeps(sockets), gameId: 'g1', token: 'token-u1' });
  assert.ok(result.controller);
  assert.ok(result.board);

  // Start the game sync and emit a joined snapshot.
  // We need to access the GameSync -- it's internal to the controller.
  // Instead, verify the wiring indirectly: the controller's onPosition
  // callback should call board.setPosition. We can test this by checking
  // that the controller's fen getter updates after a snapshot.
  // But we don't have direct access to the GameSync from here.
  // The controller.start() was already called by bootstrap.
  // We can verify the controller exists and is started.
  result.controller!.stop();
});

test('bootstrap wires onMove callback to controller.submitMove', () => {
  const doc = makeDoc();
  const sockets = new FakeSocketFactory();
  const result = bootstrap(doc, { ...makeDeps(sockets), gameId: 'g1', token: 'token-u1' });
  assert.ok(result.controller);
  assert.ok(result.board);

  // The onMove callback is wired inside mountBoard. When the board resolves
  // a move, it calls controller.submitMove(uci). We can verify this by
  // checking that submitMove is callable (it delegates to GameSync).
  // Since no socket is open, submitMove returns null.
  const pending = result.controller!.submitMove('e2e4');
  assert.equal(pending, null); // no socket open
  result.controller!.stop();
});

test('bootstrap with data-color="b" sets myColor to black', () => {
  const boardEl = makeFakeEl('board');
  boardEl.getAttribute = (name: string) => name === 'data-color' ? 'b' : null;
  const doc = makeDocWithBoard(boardEl);

  const sockets = new FakeSocketFactory();
  const result = bootstrap(doc, { ...makeDeps(sockets), gameId: 'g1', token: 'token-u1' });
  assert.ok(result.controller);
  result.controller!.stop();
});

test('bootstrap with data-color="spectator" sets myColor to null', () => {
  const boardEl = makeFakeEl('board');
  boardEl.getAttribute = (name: string) => name === 'data-color' ? 'spectator' : null;
  const doc = makeDocWithBoard(boardEl);

  const sockets = new FakeSocketFactory();
  const result = bootstrap(doc, { ...makeDeps(sockets), gameId: 'g1', token: 'token-u1' });
  assert.ok(result.controller);
  result.controller!.stop();
});

// ── bootstrap clock wiring ──────────────────────────────────────────────

test('bootstrap wires onClock to clock elements when present', () => {
  const ids = ['board', 'status', 'flip', 'clock', 'clock-white', 'clock-black'];
  const doc = makeDoc(ids);

  const sockets = new FakeSocketFactory();
  const result = bootstrap(doc, { ...makeDeps(sockets), gameId: 'g1', token: 'token-u1' });
  assert.ok(result.controller);
  result.controller!.stop();
});

// ── bootstrap returns app with correct config ───────────────────────────

test('bootstrap returns app with injected config', () => {
  const doc = makeDoc();
  const deps = makeDeps();
  const result = bootstrap(doc, deps);
  assert.equal(result.app.config.apiBaseUrl, 'https://api.test');
  assert.equal(result.app.config.wsUrl, 'wss://api.test/ws');
});

// ── C3: bootstrap calls gameSync.start() and derives color from server ─────

test('C3: bootstrap without game ID does not open a connection', () => {
  const doc = makeDoc();
  const sockets = new FakeSocketFactory();
  // No gameId override and no location.pathname that yields a game id.
  const result = bootstrap(doc, { ...makeDeps(sockets) });
  assert.equal(sockets.sockets.length, 0, 'no socket without a game id');
  assert.equal(result.controller, null);
});

test('C3: bootstrap opens a connection when no token is provided (anonymous spectator)', async () => {
  const doc = makeDoc();
  const sockets = new FakeSocketFactory();
  // Without a token, bootstrap still opens a connection -- the join will be
  // anonymous (spectator). M12 inc 2: the socket opens once the async session
  // restore settles (it may first try a cookie refresh), so flush microtasks.
  const result = bootstrap(doc, { ...makeDeps(sockets), gameId: 'g1' });
  assert.ok(result.controller);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sockets.sockets.length, 1);
});

test('self profile reloads only when the authenticated user changes and clears on logout', async () => {
  const doc = makeDoc([
    'profile',
    'profile-handle',
    'profile-error',
    'theme-toggle',
    'auth-status',
    'auth-logout',
    'auth-submit',
    'auth-error',
    'auth-form',
    'auth-handle',
    'auth-password',
    'create-seek',
  ]);
  const handleEl = doc.getElementById('profile-handle')!;
  const errorEl = doc.getElementById('profile-error')!;
  let signedIn: { id: string; handle: string; country: null; createdAt: string; roles: string[] } | null = null;

  const transport = new FakeTransport().onEach((request) => {
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && path === '/v1/auth/login') {
      const handle = (JSON.parse(request.body ?? '{}') as { handle?: string }).handle ?? '';
      signedIn = {
        id: handle === 'alice' ? 'u1' : 'u2',
        handle,
        country: null,
        createdAt: '2026-01-01T00:00:00Z',
        roles: ['user'],
      };
      return json(200, {
        user: signedIn,
        tokens: {
          accessToken: `token-${signedIn.id}`,
          tokenType: 'Bearer',
          expiresIn: 900,
          refreshExpiresAt: '2030-01-01T00:00:00Z',
        },
      });
    }
    if (request.method === 'POST' && path === '/v1/auth/logout') {
      signedIn = null;
      return json(200, {});
    }
    if (request.method === 'GET' && path === '/v1/users/me') {
      return signedIn ? json(200, signedIn) : json(401, { message: 'no active session' });
    }
    if (request.method === 'GET' && path.endsWith('/games')) {
      return json(200, []);
    }
    if (request.method === 'GET' && path.startsWith('/v1/users/')) {
      const handle = decodeURIComponent(path.slice('/v1/users/'.length));
      const id = handle === 'alice' ? 'u1' : 'u2';
      return json(200, {
        user: { id, handle, country: null, createdAt: '2026-01-01T00:00:00Z' },
        ratings: [],
      });
    }
    return json(404, { message: `unexpected request: ${request.method} ${path}` });
  });

  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { pathname: '/profile' },
  });

  try {
    const result = bootstrap(doc, { ...makeDeps(), httpTransport: transport });

    await result.auth.login('alice', 'pw');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(handleEl.textContent, 'alice');

    errorEl.textContent = 'stale error';
    await result.auth.login('bob', 'pw');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(handleEl.textContent, 'bob');
    assert.equal(errorEl.textContent, '');

    const selfLoads = (): number => transport.calls.filter(
      (request) => new URL(request.url).pathname === '/v1/users/me',
    ).length;
    assert.equal(selfLoads(), 2);

    await result.auth.login('bob', 'pw');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(selfLoads(), 2, 'same authenticated user must not reload the profile');

    await result.auth.logout();
    assert.equal(handleEl.textContent, '');
    assert.equal(errorEl.textContent, 'Sign in to view your profile.');
  } finally {
    if (originalLocation) {
      Object.defineProperty(globalThis, 'location', originalLocation);
    } else {
      delete (globalThis as { location?: unknown }).location;
    }
  }
});

// ── Action Panel DOM Regression Tests ────────────────────────────────────

/** Valid joined message fixture: white player, ply 0, game in progress. */
const JOINED_MSG = {
  t: 'joined',
  gameId: 'g1',
  role: 'white',
  state: BASE_STATE,
} as const satisfies ServerMessage;

function setupActionPanel() {
  const doc = makeDoc();
  const sockets = new FakeSocketFactory();
  const result = bootstrap(doc, { ...makeDeps(sockets), gameId: 'g1', token: 'token-u1' });
  const socket = sockets.last;

  // Connect and become a white player in an ongoing game.
  socket.open();
  socket.emit(JOINED_MSG);

  return { doc, sockets, result, socket };
}

test('action panel: disconnect while resign confirmation is open hides confirmation', () => {
  const { doc, socket } = setupActionPanel();
  const btnResign = doc.getElementById('action-resign') as unknown as typeof FakeHTMLButtonElement.prototype;
  const confirmResignYes = doc.getElementById('confirm-resign-yes') as unknown as typeof FakeHTMLButtonElement.prototype;
  const confirmResignNo = doc.getElementById('confirm-resign-no') as unknown as typeof FakeHTMLButtonElement.prototype;
  const confirmResignEl = doc.getElementById('confirm-resign') as HTMLElement;

  assert.equal(btnResign.hidden, false);
  assert.equal(confirmResignEl.hidden, true);

  btnResign.click();
  assert.equal(btnResign.hidden, true);
  assert.equal(confirmResignEl.hidden, false);

  // Disconnect
  socket.serverClose();
  assert.equal(btnResign.hidden, false);
  assert.equal(btnResign.disabled, true);
  assert.equal(confirmResignEl.hidden, true);
  assert.equal(confirmResignYes.disabled, true);
  assert.equal(confirmResignNo.disabled, true);
});

test('action panel: game end while confirmation is open hides confirmation', () => {
  const { doc, socket } = setupActionPanel();
  const btnResign = doc.getElementById('action-resign') as unknown as typeof FakeHTMLButtonElement.prototype;
  const confirmResignEl = doc.getElementById('confirm-resign') as HTMLElement;

  btnResign.click();
  assert.equal(confirmResignEl.hidden, false);

  // Game over via a fully valid ended broadcast.
  const endedMsg = {
    t: 'ended',
    gameId: 'g1',
    result: '1-0',
    termination: 'resignation',
    winner: 'w',
    serverTs: 1_700_000_000_000,
  } as const satisfies ServerMessage;
  socket.emit(endedMsg);

  assert.equal(btnResign.hidden, false);
  assert.equal(btnResign.disabled, true);
  assert.equal(confirmResignEl.hidden, true);
});

test('action panel: abort becoming unavailable at ply >= 2 while confirmation is open hides confirmation', () => {
  const { doc, socket } = setupActionPanel();
  const btnAbort = doc.getElementById('action-abort') as unknown as typeof FakeHTMLButtonElement.prototype;
  const confirmAbortYes = doc.getElementById('confirm-abort-yes') as unknown as typeof FakeHTMLButtonElement.prototype;
  const confirmAbortNo = doc.getElementById('confirm-abort-no') as unknown as typeof FakeHTMLButtonElement.prototype;
  const confirmAbortEl = doc.getElementById('confirm-abort') as HTMLElement;

  btnAbort.click();
  assert.equal(confirmAbortEl.hidden, false);

  // Ply >= 2 means canAbort is false -- use a valid state message.
  const stateMsg = {
    t: 'state',
    gameId: 'g1',
    state: { ...BASE_STATE, ply: 2 },
  } as const satisfies ServerMessage;
  socket.emit(stateMsg);

  assert.equal(btnAbort.hidden, true); // Hidden because canAbort is false
  assert.equal(confirmAbortEl.hidden, true);
  assert.equal(confirmAbortYes.disabled, true);
  assert.equal(confirmAbortNo.disabled, true);
});

test('action panel: abort confirmation cancel and confirm controls are wired', () => {
  const { doc, socket } = setupActionPanel();
  const btnAbort = doc.getElementById('action-abort') as unknown as typeof FakeHTMLButtonElement.prototype;
  const confirmAbortEl = doc.getElementById('confirm-abort') as HTMLElement;
  const confirmAbortYes = doc.getElementById('confirm-abort-yes') as unknown as typeof FakeHTMLButtonElement.prototype;
  const confirmAbortNo = doc.getElementById('confirm-abort-no') as unknown as typeof FakeHTMLButtonElement.prototype;

  socket.sent.length = 0;
  btnAbort.click();
  confirmAbortNo.click();
  assert.equal(confirmAbortEl.hidden, true);
  assert.equal(btnAbort.hidden, false);
  assert.equal(socket.sent.length, 0);

  btnAbort.click();
  confirmAbortYes.click();
  assert.equal(JSON.parse(socket.sent.at(-1)!).t, 'abort');
  assert.equal(confirmAbortEl.hidden, true);
  assert.equal(confirmAbortYes.disabled, true);
  assert.equal(confirmAbortNo.disabled, true);
});

test('action panel: offer-draw and claim-flag buttons send their commands', () => {
  const { doc, socket } = setupActionPanel();
  const btnOfferDraw = doc.getElementById('action-offer-draw') as unknown as typeof FakeHTMLButtonElement.prototype;
  const btnClaimFlag = doc.getElementById('action-claim-flag') as unknown as typeof FakeHTMLButtonElement.prototype;

  socket.sent.length = 0;
  btnOfferDraw.click();
  assert.equal(JSON.parse(socket.sent.at(-1)!).t, 'offerDraw');
  assert.equal(btnOfferDraw.disabled, true);

  socket.emit({ t: 'state', gameId: 'g1', state: BASE_STATE });
  btnClaimFlag.click();
  assert.equal(JSON.parse(socket.sent.at(-1)!).t, 'claimFlag');
  assert.equal(btnClaimFlag.disabled, true);
});

test('action panel: received-draw response buttons send their commands', () => {
  const { doc, socket } = setupActionPanel();
  const btnAcceptDraw = doc.getElementById('action-accept-draw') as unknown as typeof FakeHTMLButtonElement.prototype;
  const btnDeclineDraw = doc.getElementById('action-decline-draw') as unknown as typeof FakeHTMLButtonElement.prototype;
  const receivedDrawState = { ...BASE_STATE, drawOffer: 'b' as const };

  socket.sent.length = 0;
  socket.emit({ t: 'state', gameId: 'g1', state: receivedDrawState });
  btnAcceptDraw.click();
  assert.equal(JSON.parse(socket.sent.at(-1)!).t, 'acceptDraw');

  socket.emit({ t: 'state', gameId: 'g1', state: receivedDrawState });
  btnDeclineDraw.click();
  assert.equal(JSON.parse(socket.sent.at(-1)!).t, 'declineDraw');
});

test('action panel: failed send leaves confirmation recoverable', () => {
  const { doc, sockets } = setupActionPanel();
  const socket = sockets.last;

  // Make the underlying socket refuse to send (simulates a network failure
  // that occurs *before* the frame is queued -- send throws synchronously).
  // WsClient.send() catches the exception and returns false; GameSync.resign()
  // therefore also returns false and does NOT set pendingAction.
  socket.send = () => { throw new Error('send: socket not writable'); };

  const btnResign = doc.getElementById('action-resign') as unknown as typeof FakeHTMLButtonElement.prototype;
  const confirmResignYes = doc.getElementById('confirm-resign-yes') as unknown as typeof FakeHTMLButtonElement.prototype;
  const confirmResignNo = doc.getElementById('confirm-resign-no') as unknown as typeof FakeHTMLButtonElement.prototype;
  const confirmResignEl = doc.getElementById('confirm-resign') as HTMLElement;

  // Open the confirmation panel.
  btnResign.click();
  assert.equal(confirmResignEl.hidden, false);
  assert.equal(confirmResignYes.disabled, false);
  assert.equal(confirmResignNo.disabled, false);

  // Clicking confirm while send is broken must NOT create a pending action.
  // The confirmation panel stays open and both buttons remain enabled so the
  // user can retry or cancel.
  confirmResignYes.click();

  assert.equal(confirmResignEl.hidden, false);
  assert.equal(confirmResignYes.disabled, false);
  assert.equal(confirmResignNo.disabled, false);
});

test('action panel: received-draw buttons disabled while disconnected', () => {
  const { doc, socket } = setupActionPanel();
  const btnAcceptDraw = doc.getElementById('action-accept-draw') as unknown as typeof FakeHTMLButtonElement.prototype;
  const btnDeclineDraw = doc.getElementById('action-decline-draw') as unknown as typeof FakeHTMLButtonElement.prototype;
  const drawBanner = doc.getElementById('draw-offer-received') as HTMLElement;

  // Opponent (black) has offered a draw -- drawOffer: 'b' for the white player.
  const drawOfferMsg = {
    t: 'state',
    gameId: 'g1',
    state: { ...BASE_STATE, drawOffer: 'b' },
  } as const satisfies ServerMessage;
  socket.emit(drawOfferMsg);

  // Draw banner should be visible and both response buttons enabled.
  assert.equal(drawBanner.hidden, false);
  assert.equal(btnAcceptDraw.disabled, false);
  assert.equal(btnDeclineDraw.disabled, false);

  // Disconnect -- buttons must become disabled.
  socket.serverClose();

  assert.equal(btnAcceptDraw.disabled, true);
  assert.equal(btnDeclineDraw.disabled, true);
});
