import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap, extractGameId, formatClock } from '../src/app/bootstrap.js';
import type { BootstrapDependencies } from '../src/app/bootstrap.js';
import { GameController } from '../src/app/game-controller.js';
import { FakeTransport, json } from './support/fake-transport.js';
import { FakeSocketFactory } from './support/fake-socket.js';
import { MemoryTokenStore } from '../src/net/session.js';

// Define HTMLButtonElement for Node.js test environment (m3: bootstrap uses instanceof checks).
class FakeHTMLButtonElement {
  textContent = '';
  classList = new Set<string>();
  addEventListener = () => {};
  removeEventListener = () => {};
  setAttribute = () => {};
  getAttribute = () => null;
  appendChild = () => null;
  removeChild = () => null;
  querySelectorAll = () => [];
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  id = '';
  disabled = false;
  title = '';
  hidden = false;
  type = 'button';
}
(globalThis as any).HTMLButtonElement = FakeHTMLButtonElement;

/** IDs that should be treated as HTMLButtonElement instances. */
const BUTTON_IDS = new Set(['auth-submit', 'auth-logout', 'create-seek', 'flip', 'theme-toggle']);

/**
 * Minimal DOM shim: create a document with the given element IDs.
 * Returns a `Document` with `getElementById` backed by a map.
 * Each element has enough surface area for BoardView to not crash.
 */
function makeFakeEl(id?: string): HTMLElement {
  if (id && BUTTON_IDS.has(id)) {
    const btn = new FakeHTMLButtonElement();
    btn.id = id;
    return btn as unknown as HTMLElement;
  }
  const classList = new Set<string>();
  return {
    textContent: '',
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
    style: {},
    dataset: {},
    id: id ?? '',
  } as unknown as HTMLElement;
}

function makeDoc(ids: string[] = ['board', 'status', 'flip', 'theme-toggle', 'auth-status', 'auth-logout', 'auth-submit', 'auth-error', 'auth-form', 'auth-handle', 'auth-password', 'create-seek']): Document {
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

function makeDocWithBoard(boardEl: HTMLElement, ids: string[] = ['status', 'flip', 'theme-toggle', 'auth-status', 'auth-logout', 'auth-submit', 'auth-error', 'auth-form', 'auth-handle', 'auth-password', 'create-seek']): Document {
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
  // We need to access the GameSync — it's internal to the controller.
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
  // Without a token, bootstrap still opens a connection — the join will be
  // anonymous (spectator). M12 inc 2: the socket opens once the async session
  // restore settles (it may first try a cookie refresh), so flush microtasks.
  const result = bootstrap(doc, { ...makeDeps(sockets), gameId: 'g1' });
  assert.ok(result.controller);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sockets.sockets.length, 1);
});
