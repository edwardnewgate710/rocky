import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mountLobby, renderSeeks } from '../src/app/lobby-mount.js';
import { LobbyController } from '../src/app/lobby-controller.js';
import type {
  CreateBotGameRequest,
  CreateSeekRequest,
  GameSummary,
  SeekView,
  Variant,
} from '../src/api/models.js';
import type { GambitClient } from '../src/api/client.js';
import type { KeyValueStorage } from '../src/net/session.js';

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

class FakeDOMElement {
  readonly tagName: string;
  id = '';
  className = '';
  type = '';
  value = '';
  hidden = false;
  disabled = false;
  title = '';
  open = false;
  checked = false;
  selected = false;
  name = '';
  innerHTML = '';
  dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: FakeDOMElement[] = [];
  parentElement: FakeDOMElement | null = null;
  readonly listeners: Record<string, ((event: Event) => void)[]> = {};
  _doc: Document | null = null;
  private _textContent = '';

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get textContent(): string {
    if (this._textContent !== '') return this._textContent;
    if (this.children.length > 0) {
      return this.children.map((c) => c.textContent).join('');
    }
    return '';
  }

  set textContent(val: string) {
    this._textContent = val;
    this.children.length = 0;
  }

  get ownerDocument(): Document | null {
    return this._doc;
  }

  readonly classList = {
    _classes: new Set<string>(),
    add: (...tokens: string[]): void => {
      for (const t of tokens) {
        if (t) {
          this.classList._classes.add(t);
          if (!this.className.split(' ').includes(t)) {
            this.className = this.className ? `${this.className} ${t}` : t;
          }
        }
      }
    },
    remove: (...tokens: string[]): void => {
      for (const t of tokens) {
        this.classList._classes.delete(t);
      }
      this.className = Array.from(this.classList._classes).join(' ');
    },
    contains: (token: string): boolean => {
      return this.classList._classes.has(token) || this.className.split(' ').includes(token);
    },
    toggle: (token: string, force?: boolean): boolean => {
      const exists = this.classList.contains(token);
      const next = force !== undefined ? force : !exists;
      if (next) this.classList.add(token);
      else this.classList.remove(token);
      return next;
    },
  };

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'id') this.id = value;
    if (name === 'class') {
      this.className = value;
      this.classList._classes = new Set(value.split(' ').filter(Boolean));
    }
    if (name === 'type') this.type = value;
    if (name === 'value') this.value = value;
    if (name === 'name') this.name = value;
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      this.dataset[key] = value;
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  appendChild<T extends FakeDOMElement>(child: T): T {
    child.parentElement = this;
    child._doc = this._doc;
    this.children.push(child);
    return child;
  }

  append(...nodes: (FakeDOMElement | string)[]): void {
    for (const n of nodes) {
      if (typeof n === 'string') {
        const textNode = new FakeDOMElement('#text');
        textNode.textContent = n;
        this.appendChild(textNode);
      } else {
        this.appendChild(n);
      }
    }
  }

  replaceChildren(...nodes: (FakeDOMElement | string)[]): void {
    this.children.length = 0;
    this._textContent = '';
    this.append(...nodes);
  }

  addEventListener(type: string, fn: (event: Event) => void): void {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type]!.push(fn);
  }

  removeEventListener(type: string, fn: (event: Event) => void): void {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type]!.filter((cb) => cb !== fn);
  }

  listenerCount(type: string): number {
    return this.listeners[type]?.length ?? 0;
  }

  dispatchEvent(event: Event): boolean {
    if (!event.target) {
      Object.defineProperty(event, 'target', { value: this, configurable: true });
    }
    if (!event.preventDefault) {
      Object.defineProperty(event, 'preventDefault', { value: () => {}, configurable: true });
    }
    const handlers = this.listeners[event.type] ?? [];
    for (const h of handlers) {
      h(event);
    }
    return true;
  }

  click(): void {
    if (this.disabled) return;
    let prevented = false;
    const clickEvent = {
      type: 'click',
      target: this as unknown as EventTarget,
      get defaultPrevented(): boolean { return prevented; },
      preventDefault(): void { prevented = true; },
    } as unknown as Event;
    this.dispatchEvent(clickEvent);
    if (this.parentElement) {
      let p: FakeDOMElement | null = this.parentElement;
      while (p) {
        p.dispatchEvent(clickEvent);
        p = p.parentElement;
      }
    }
  }

  focus(): void {}

  showModal(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
    this.dispatchEvent({
      type: 'close',
      target: this as unknown as EventTarget,
      defaultPrevented: false,
      preventDefault(): void {},
    } as unknown as Event);
  }

  querySelector<T extends FakeDOMElement = FakeDOMElement>(selector: string): T | null {
    const matches = this.querySelectorAll<T>(selector);
    return matches[0] ?? null;
  }

  querySelectorAll<T extends FakeDOMElement = FakeDOMElement>(selector: string): T[] {
    const results: T[] = [];
    const walk = (node: FakeDOMElement): void => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) {
          results.push(child as unknown as T);
        }
        walk(child);
      }
    };
    walk(this);
    return results;
  }
}

function matchesSelector(node: FakeDOMElement, selector: string): boolean {
  if (selector.startsWith('input[name="') && selector.endsWith('"]:checked')) {
    const name = selector.slice('input[name="'.length, -'"]:checked'.length);
    return node.tagName === 'INPUT' && (node.getAttribute('name') === name || node.name === name) && node.checked;
  }
  if (selector.startsWith('input[name="') && selector.endsWith('"]')) {
    const name = selector.slice('input[name="'.length, -'"]'.length);
    return node.tagName === 'INPUT' && (node.getAttribute('name') === name || node.name === name);
  }
  if (selector === 'button') {
    return node.tagName === 'BUTTON';
  }
  if (selector.startsWith('.')) {
    return node.classList.contains(selector.slice(1));
  }
  if (selector.startsWith('#')) {
    return node.id === selector.slice(1);
  }
  return node.tagName.toLowerCase() === selector.toLowerCase();
}

// Global prototype setup for instanceof checks in browser controllers
(globalThis as unknown as { HTMLElement: typeof FakeDOMElement }).HTMLElement = FakeDOMElement;
(globalThis as unknown as { HTMLButtonElement: typeof FakeDOMElement }).HTMLButtonElement = FakeDOMElement;
(globalThis as unknown as { HTMLInputElement: typeof FakeDOMElement }).HTMLInputElement = FakeDOMElement;
(globalThis as unknown as { HTMLSelectElement: typeof FakeDOMElement }).HTMLSelectElement = FakeDOMElement;
(globalThis as unknown as { HTMLDialogElement: typeof FakeDOMElement }).HTMLDialogElement = FakeDOMElement;
(globalThis as unknown as { HTMLFormElement: typeof FakeDOMElement }).HTMLFormElement = FakeDOMElement;
(globalThis as unknown as { HTMLParagraphElement: typeof FakeDOMElement }).HTMLParagraphElement = FakeDOMElement;
(globalThis as unknown as { HTMLLabelElement: typeof FakeDOMElement }).HTMLLabelElement = FakeDOMElement;

function createTestDoc(): {
  doc: Document;
  elements: Map<string, FakeDOMElement>;
} {
  const elements = new Map<string, FakeDOMElement>();

  const doc = {
    createElement: (tag: string): FakeDOMElement => {
      const el = new FakeDOMElement(tag);
      el._doc = doc as unknown as Document;
      return el;
    },
    getElementById: (id: string): FakeDOMElement | null => elements.get(id) ?? null,
  } as unknown as Document;

  const ids = [
    'lobby',
    'seek-list',
    'create-game',
    'play-bot-mount',
    'lobby-error',
    'auth',
    'auth-status',
    'auth-logout',
    'auth-submit',
    'auth-register',
    'auth-passkey',
    'auth-error',
    'auth-form',
    'auth-handle',
    'auth-password',
    'theme-toggle',
  ];

  for (const id of ids) {
    const el = new FakeDOMElement('div');
    el.id = id;
    el._doc = doc;
    elements.set(id, el);
  }

  return { doc, elements };
}

function makeSeek(overrides: Partial<SeekView> = {}): SeekView {
  return {
    id: 'seek-1',
    creatorId: 'user-1',
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

function makeFakeGameSummary(id: string): GameSummary {
  return {
    id,
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
  };
}

/** Build a typed lobby client seam and capture every create/accept/cancel call. */
function makeFakeClient(opts: {
  seeks?: SeekView[];
  createSeekResult?: SeekView;
  createSeek?: (body: CreateSeekRequest) => Promise<SeekView>;
  createBotGameError?: string;
  createBotGameResultId?: string;
  acceptSeek?: (id: string) => Promise<SeekView>;
  createBotGame?: (body: CreateBotGameRequest) => Promise<GameSummary>;
  userId?: string | null;
} = {}) {
  const createdSeeks: CreateSeekRequest[] = [];
  const canceledSeeks: string[] = [];
  const acceptedSeeks: string[] = [];
  const botGameCalls: CreateBotGameRequest[] = [];

  const client = {
    session: {
      current: opts.userId ? { user: { id: opts.userId, handle: 'alice' } } : null,
    },
    seeks: {
      list: async (): Promise<SeekView[]> => opts.seeks ?? [],
      create: async (body: CreateSeekRequest): Promise<SeekView> => {
        createdSeeks.push(body);
        if (opts.createSeek) return opts.createSeek(body);
        return opts.createSeekResult ?? makeSeek({ id: 'new-seek-id', ...(body as Partial<SeekView>) });
      },
      cancel: async (id: string): Promise<void> => {
        canceledSeeks.push(id);
      },
      accept: async (id: string): Promise<SeekView> => {
        acceptedSeeks.push(id);
        if (opts.acceptSeek) return opts.acceptSeek(id);
        return makeSeek({ id, gameId: 'game-matched-1' });
      },
    },
    games: {
      createVsBot: async (body: CreateBotGameRequest): Promise<GameSummary> => {
        botGameCalls.push(body);
        if (opts.createBotGame) return opts.createBotGame(body);
        if (opts.createBotGameError) {
          throw new Error(opts.createBotGameError);
        }
        return makeFakeGameSummary(opts.createBotGameResultId ?? 'bot-game-100');
      },
    },
  } as unknown as GambitClient;

  return { client, createdSeeks, canceledSeeks, acceptedSeeks, botGameCalls };
}

const mountedControllers = new Set<LobbyController>();

function mountTestLobby(deps: Parameters<typeof mountLobby>[0]): ReturnType<typeof mountLobby> {
  const mounted = mountLobby(deps);
  mountedControllers.add(mounted.lobby);
  return mounted;
}

afterEach(() => {
  for (const controller of mountedControllers) controller.dispose();
  mountedControllers.clear();
});

function submit(form: FakeDOMElement): void {
  let prevented = false;
  form.dispatchEvent({
    type: 'submit',
    target: form as unknown as EventTarget,
    get defaultPrevented(): boolean { return prevented; },
    preventDefault(): void { prevented = true; },
  } as unknown as Event);
}

/** Select exactly one radio in the fake DOM's named group. */
function selectRadio(form: FakeDOMElement, name: string, value: string): void {
  const radios = form.querySelectorAll<FakeDOMElement>(`input[name="${name}"]`);
  for (const radio of radios) radio.checked = radio.value === value;
}

// ── Tests ─────────────────────────────────────────────────────────────

test('renderSeeks: renders empty state when no seeks are open', () => {
  const { doc } = createTestDoc();
  const container = doc.createElement('div') as unknown as HTMLElement & FakeDOMElement;

  renderSeeks(container, [], null);

  assert.ok(container.children.length > 0);
  const empty = container.children[0];
  assert.ok(empty);
  assert.ok(empty.classList.contains('empty'));
  assert.equal(empty.querySelector('.empty-mark')?.textContent, '♟');
  assert.equal(empty.querySelector('.empty-title')?.textContent, 'No open seeks right now');
  assert.equal(empty.querySelector('.empty-body')?.textContent, 'Create a game above — the first player to accept joins you.');
});

test('renderSeeks: renders owned seek with cancel affordance and waiting indicator', () => {
  const { doc } = createTestDoc();
  const container = doc.createElement('div') as unknown as HTMLElement & FakeDOMElement;
  const seek = makeSeek({
    id: 's-own',
    creatorId: 'user-me',
    variant: 'standard',
    speed: 'blitz',
    rated: true,
  });

  renderSeeks(container, [seek], 'user-me');

  assert.equal(container.children.length, 1);
  const row = container.children[0];
  assert.ok(row);
  assert.ok(row.classList.contains('seek-row'));
  assert.ok(row.classList.contains('seek-row-own'));
  assert.equal(row.dataset['seekId'], 's-own');

  const info = row.querySelector('.seek-info');
  assert.equal(info?.textContent, 'standard · blitz · 3+2 · rated');

  const waiting = row.querySelector('.seek-waiting');
  assert.ok(waiting);
  assert.equal(waiting.querySelector('.seek-dot')?.getAttribute('aria-hidden'), 'true');
  assert.equal(waiting.children[1]?.textContent, 'Waiting for an opponent…');

  const cancelBtn = row.querySelector<FakeDOMElement>('.seek-cancel');
  assert.ok(cancelBtn);
  assert.equal(cancelBtn.textContent, 'Cancel');
  assert.equal(cancelBtn.dataset['seekId'], 's-own');
  assert.equal(cancelBtn.getAttribute('aria-label'), 'Cancel your seek');
});

test('renderSeeks: renders other player seek with accept Play button', () => {
  const { doc } = createTestDoc();
  const container = doc.createElement('div') as unknown as HTMLElement & FakeDOMElement;
  const seek = makeSeek({
    id: 's-other',
    creatorId: 'user-them',
    variant: 'standard',
    speed: 'rapid',
    timeControl: { initialMs: 600_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    rated: false,
  });

  renderSeeks(container, [seek], 'user-me');

  assert.equal(container.children.length, 1);
  const row = container.children[0];
  assert.ok(row);
  assert.ok(row.classList.contains('seek-row'));
  assert.ok(!row.classList.contains('seek-row-own'));
  assert.equal(row.dataset['seekId'], 's-other');

  const info = row.querySelector('.seek-info');
  assert.equal(info?.textContent, 'standard · rapid · 10 min');

  const acceptBtn = row.querySelector<FakeDOMElement>('.seek-accept');
  assert.ok(acceptBtn);
  assert.ok(acceptBtn.classList.contains('button'));
  assert.ok(acceptBtn.classList.contains('primary'));
  assert.equal(acceptBtn.textContent, 'Play');
  assert.equal(acceptBtn.dataset['seekId'], 's-other');
  assert.equal(acceptBtn.getAttribute('aria-label'), 'Accept seek');
});

test('mountLobby: wires delegated cancel button click to lobby.cancelSeek', async () => {
  const { doc, elements } = createTestDoc();
  const seekListEl = elements.get('seek-list')!;
  const { client, canceledSeeks } = makeFakeClient();

  mountTestLobby({
    doc,
    client,
    isAuthenticated: () => true,
  });

  renderSeeks(seekListEl as unknown as HTMLElement, [makeSeek({ id: 'seek-to-cancel', creatorId: 'me' })], 'me');

  const cancelBtn = seekListEl.querySelector('.seek-cancel');
  assert.ok(cancelBtn);
  cancelBtn.click();
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(canceledSeeks, ['seek-to-cancel']);
});

test('mountLobby: wires delegated accept button click to lobby.acceptSeek', async () => {
  const { doc, elements } = createTestDoc();
  const seekListEl = elements.get('seek-list')!;
  const { client, acceptedSeeks } = makeFakeClient();

  mountTestLobby({
    doc,
    client,
    isAuthenticated: () => true,
  });

  renderSeeks(seekListEl as unknown as HTMLElement, [makeSeek({ id: 'seek-to-accept', creatorId: 'other' })], 'me');

  const acceptBtn = seekListEl.querySelector('.seek-accept');
  assert.ok(acceptBtn);
  acceptBtn.click();
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(acceptedSeeks, ['seek-to-accept']);
});

test('POST-AUD-001: repeated lobby mounts do not stack delegated seek listeners', () => {
  const { doc, elements } = createTestDoc();
  const seekListEl = elements.get('seek-list')!;
  const { client } = makeFakeClient();

  const first = mountTestLobby({ doc, client, isAuthenticated: () => true });
  assert.equal(seekListEl.listenerCount('click'), 1);

  first.lobby.dispose();
  assert.equal(seekListEl.listenerCount('click'), 0);

  const second = mountTestLobby({ doc, client, isAuthenticated: () => true });
  assert.equal(seekListEl.listenerCount('click'), 1);

  second.lobby.dispose();
  second.lobby.dispose();
  assert.equal(seekListEl.listenerCount('click'), 0);
});

test('POST-AUD-001: deferred seek acceptance cannot navigate after disposal', async () => {
  const pendingAcceptance = deferred<SeekView>();
  const { doc, elements } = createTestDoc();
  const { client } = makeFakeClient({ acceptSeek: () => pendingAcceptance.promise });
  const locationState = { href: '' };
  const target = globalThis as unknown as Record<string, unknown>;
  const originalWindow = target['window'];
  target['window'] = { location: locationState };

  try {
    const mounted = mountTestLobby({ doc, client, isAuthenticated: () => true });
    renderSeeks(
      elements.get('seek-list') as unknown as HTMLElement,
      [makeSeek({ id: 'pending-seek', creatorId: 'other' })],
      'me',
    );
    elements.get('seek-list')!.querySelector('.seek-accept')!.click();
    mounted.lobby.dispose();
    pendingAcceptance.resolve(makeSeek({ id: 'pending-seek', gameId: 'stale-game' }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(locationState.href, '');
  } finally {
    if (originalWindow === undefined) delete target['window'];
    else target['window'] = originalWindow;
  }
});

test('mountLobby: session changes update PlayBotDialog without changing create-panel state', () => {
  const { doc, elements } = createTestDoc();
  const { client } = makeFakeClient();

  const mounted = mountTestLobby({
    doc,
    client,
    isAuthenticated: () => false,
  });

  const createBtn = elements.get('create-game')!.querySelector('#create-seek')!;
  const playBotBtn = elements.get('play-bot-mount')!.querySelector('#play-bot')!;

  assert.equal(createBtn.disabled, true);
  assert.equal(createBtn.title, 'Sign in to create a seek');
  assert.equal(playBotBtn.disabled, true);
  assert.equal(playBotBtn.title, 'Sign in to play the computer');

  // Bootstrap owns the persistent create trigger. This seam preserves the existing dialog-only
  // update that also closes an open dialog on sign-out.
  mounted.setPlayBotAuthenticated(true);

  assert.equal(createBtn.disabled, true);
  assert.equal(createBtn.title, 'Sign in to create a seek');
  assert.equal(playBotBtn.disabled, false);
  assert.equal(playBotBtn.title, '');

  mounted.setPlayBotAuthenticated(false);
  assert.equal(createBtn.disabled, true);
  assert.equal(createBtn.title, 'Sign in to create a seek');
  assert.equal(playBotBtn.disabled, true);
  assert.equal(playBotBtn.title, 'Sign in to play the computer');

});

test('mountLobby: failed play-bot submission keeps the dialog open with its error', async () => {
  const { doc, elements } = createTestDoc();
  const { client, botGameCalls } = makeFakeClient({
    createBotGameError: 'Engine service offline',
  });

  const locationState = { href: '' };
  const target = globalThis as unknown as Record<string, unknown>;
  const origWindow = target['window'];
  target['window'] = { location: locationState };

  try {
    mountTestLobby({
      doc,
      client,
      isAuthenticated: () => true,
    });

    const playBotMount = elements.get('play-bot-mount')!;
    const playBotBtn = playBotMount.querySelector('#play-bot')!;
    playBotBtn.click();

    const dialog = playBotMount.querySelector('dialog')!;
    assert.equal(dialog.open, true);

    const form = playBotMount.querySelector('form')!;
    submit(form);
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(botGameCalls.length, 1);
    assert.equal(botGameCalls[0]?.variant, 'standard');
    assert.equal(playBotMount.querySelector('#pb-error')?.textContent, 'Engine service offline');
    assert.equal(locationState.href, '');

  } finally {
    if (origWindow === undefined) {
      delete target['window'];
    } else {
      target['window'] = origWindow;
    }
  }
});

test('mountLobby: successful play-bot submission navigates to the created standard game', async () => {
  const { doc, elements } = createTestDoc();
  const { client, botGameCalls } = makeFakeClient({ createBotGameResultId: 'game-success-99' });
  const locationState = { href: '' };
  const target = globalThis as unknown as Record<string, unknown>;
  const origWindow = target['window'];
  target['window'] = { location: locationState };

  try {
    mountTestLobby({ doc, client, isAuthenticated: () => true });
    const form = elements.get('play-bot-mount')!.querySelector('form')!;
    submit(form);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(botGameCalls.length, 1);
    assert.equal(botGameCalls[0]?.variant, 'standard');
    assert.equal(locationState.href, '/game/game-success-99');
  } finally {
    if (origWindow === undefined) delete target['window'];
    else target['window'] = origWindow;
  }
});

test('POST-AUD-001: deferred bot creation cannot navigate after disposal', async () => {
  const pendingGame = deferred<GameSummary>();
  const { doc, elements } = createTestDoc();
  const { client } = makeFakeClient({ createBotGame: () => pendingGame.promise });
  const locationState = { href: '' };
  const target = globalThis as unknown as Record<string, unknown>;
  const originalWindow = target['window'];
  target['window'] = { location: locationState };

  try {
    const mounted = mountTestLobby({ doc, client, isAuthenticated: () => true });
    submit(elements.get('play-bot-mount')!.querySelector('form')!);
    mounted.lobby.dispose();
    pendingGame.resolve(makeFakeGameSummary('stale-bot-game'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(locationState.href, '');
  } finally {
    if (originalWindow === undefined) delete target['window'];
    else target['window'] = originalWindow;
  }
});

test('mountLobby: create-game V1 renders only the approved choices', () => {
  const { doc, elements } = createTestDoc();
  const { client } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });

  const form = elements.get('create-game')!.querySelector('#create-game-form')!;
  assert.deepEqual(
    form.querySelectorAll<FakeDOMElement>('input[name="cg-time"]').map((radio) => radio.value),
    ['3+0', '5+0', '10+0', '15+10'],
  );
  assert.deepEqual(
    form.querySelectorAll<FakeDOMElement>('input[name="cg-mode"]').map((radio) => radio.value),
    ['casual', 'rated'],
  );
  assert.equal(form.querySelectorAll('input[name="cg-color"]').length, 0);
  assert.equal(form.querySelector('.cg-more-toggle'), null);
  assert.equal(form.querySelector('select'), null);
});

test('mountLobby: default submit sends the exact 10+0 casual request', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  submit(mount.querySelector('#create-game-form')!);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(createdSeeks, [{
    variant: 'standard',
    timeControl: {
      initialMs: 600_000,
      incrementMs: 0,
      delayMs: 0,
      kind: 'sudden_death',
    },
    rated: false,
  }]);
});

test('mountLobby: creates the exact V1 seek request and collapses on success', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();

  mountTestLobby({
    doc,
    client,
    isAuthenticated: () => true,
  });

  const createGameMount = elements.get('create-game')!;
  const createBtn = createGameMount.querySelector('#create-seek')!;
  createBtn.click(); // Expand form

  const form = createGameMount.querySelector('#create-game-form')!;
  assert.equal(form.hidden, false);

  selectRadio(form, 'cg-time', '15+10');
  selectRadio(form, 'cg-mode', 'rated');

  submit(form);
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(createdSeeks.length, 1);
  assert.deepEqual(createdSeeks[0], {
    variant: 'standard',
    timeControl: {
      initialMs: 900_000,
      incrementMs: 10_000,
      delayMs: 0,
      kind: 'increment',
    },
    rated: true,
  });
  assert.equal(form.hidden, true); // Collapses on successful create

});

test('mountLobby: blocks duplicate seek submissions while the first is pending', async () => {
  const pendingSeek = deferred<SeekView>();
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient({ createSeek: () => pendingSeek.promise });

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;

  submit(form);
  submit(form);

  assert.equal(createdSeeks.length, 1);
  assert.equal(form.querySelector('.cg-submit')?.disabled, true);
  assert.equal(form.querySelector('.cg-submit')?.textContent, 'Creating…');

  pendingSeek.resolve(makeSeek({ id: 'pending-created' }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(form.hidden, true);
});

test('mountLobby: failed create preserves choices, unlocks submit, and retries', async () => {
  let attempt = 0;
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient({
    createSeek: async (body) => {
      attempt++;
      if (attempt === 1) throw new Error('Seek service unavailable');
      return makeSeek({ id: 'retry-created', ...(body as Partial<SeekView>) });
    },
  });

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  selectRadio(form, 'cg-time', '3+0');
  selectRadio(form, 'cg-mode', 'rated');

  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(form.hidden, false);
  assert.equal(form.querySelector<FakeDOMElement>('input[name="cg-time"]:checked')?.value, '3+0');
  assert.equal(form.querySelector<FakeDOMElement>('input[name="cg-mode"]:checked')?.value, 'rated');
  assert.equal(elements.get('lobby-error')?.textContent, 'Seek service unavailable');
  assert.equal(form.querySelector('.cg-submit')?.disabled, false);
  assert.equal(form.querySelector('.cg-submit')?.textContent, 'Create seek');

  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(createdSeeks.length, 2);
  assert.equal(form.hidden, true);
});

test('mountLobby: session loss collapses and disables the create-game panel', () => {
  const { doc, elements } = createTestDoc();
  const { client } = makeFakeClient();
  const mounted = mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  const trigger = mount.querySelector('#create-seek')!;
  const form = mount.querySelector('#create-game-form')!;
  trigger.click();

  mounted.setCreateGameAuthenticated(false);

  assert.equal(form.hidden, true);
  assert.equal(trigger.disabled, true);
  assert.equal(trigger.title, 'Sign in to create a seek');
});

test('mountLobby: reports errors to #lobby-error element', async () => {
  const { doc, elements } = createTestDoc();
  const errorEl = elements.get('lobby-error')!;
  const client = {
    session: { current: null },
    seeks: {
      list: async (): Promise<SeekView[]> => { throw new Error('Service unavailable'); },
      create: async () => null,
      cancel: async () => {},
      accept: async () => null,
    },
    games: {
      createVsBot: async () => makeFakeGameSummary('g1'),
    },
  } as unknown as GambitClient;

  const mounted = mountTestLobby({
    doc,
    client,
    isAuthenticated: () => true,
  });

  await mounted.lobby.refresh();
  assert.equal(errorEl.textContent, 'Service unavailable');

});

test('mountLobby: valid V1 storage is passed to CreateGamePanel', () => {
  const { doc } = createTestDoc();
  const { client } = makeFakeClient();
  const memoryStorage: Record<string, string> = {
    'gambit-create-game': JSON.stringify({ time: '3+0', mode: 'rated' }),
  };
  const customStorage: KeyValueStorage = {
    getItem: (key: string): string | null => memoryStorage[key] ?? null,
    setItem: (key: string, value: string): void => { memoryStorage[key] = value; },
    removeItem: (key: string): void => { delete memoryStorage[key]; },
  };

  mountTestLobby({
    doc,
    client,
    isAuthenticated: () => true,
    storage: customStorage,
  });

  const form = (doc.getElementById('create-game') as unknown as FakeDOMElement)
    .querySelector('#create-game-form');
  assert.equal(form?.querySelector<FakeDOMElement>('input[name="cg-time"]:checked')?.value, '3+0');
  assert.equal(form?.querySelector<FakeDOMElement>('input[name="cg-mode"]:checked')?.value, 'rated');
});

test('mountLobby: stale storage falls back to 10+0 casual', () => {
  const { doc } = createTestDoc();
  const { client } = makeFakeClient();
  const storage: KeyValueStorage = {
    getItem: () => JSON.stringify({ time: '3+2', mode: 'rated' }),
    setItem: () => {},
    removeItem: () => {},
  };

  mountTestLobby({ doc, client, isAuthenticated: () => true, storage });

  const form = (doc.getElementById('create-game') as unknown as FakeDOMElement)
    .querySelector('#create-game-form');
  assert.equal(form?.querySelector<FakeDOMElement>('input[name="cg-time"]:checked')?.value, '10+0');
  assert.equal(form?.querySelector<FakeDOMElement>('input[name="cg-mode"]:checked')?.value, 'casual');
});
