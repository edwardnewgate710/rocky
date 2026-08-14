import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GambitClient } from '../src/api/client.js';
import { MessagesController } from '../src/app/messages-controller.js';
import { mountConversation, mountMessagesInbox } from '../src/app/messaging-mounts.js';

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function emptyDocument(): Document {
  return { getElementById: () => null } as unknown as Document;
}

test('inbox waits for session restoration and disposal prevents its delayed request', async () => {
  const restored = deferred();
  let requests = 0;
  const client = {
    session: { current: null },
    messages: {
      listConversations: async () => {
        requests += 1;
        return { total: 0, items: [] };
      },
    },
    graphql: { resolvePlayers: async () => new Map() },
  } as unknown as GambitClient;

  const controller = mountMessagesInbox({
    doc: emptyDocument(),
    client,
    sessionPresent: false,
    restorePromise: restored.promise,
  });
  assert.equal(requests, 0);

  controller.dispose();
  restored.resolve();
  await restored.promise;
  await Promise.resolve();
  assert.equal(requests, 0);
});

test('re-mounting a conversation replaces its composer handler and retains text on failure', async () => {
  let firstSends = 0;
  let secondSends = 0;
  let focused = 0;
  const composer = { onsubmit: null as ((event: Event) => void) | null };
  const input = {
    value: '  message worth keeping  ',
    disabled: false,
    focus: () => {
      focused += 1;
    },
  };
  const doc = {
    getElementById: (id: string) => {
      if (id === 'conversation-composer') return composer;
      if (id === 'composer-input') return input;
      return null;
    },
  } as unknown as Document;
  const neverRestored = new Promise<void>(() => {});
  const client = (onSend: () => void) => ({
    session: { current: null },
    messages: {
      send: async () => {
        onSend();
        throw new Error('network down');
      },
    },
    graphql: { resolvePlayers: async () => new Map() },
  }) as unknown as GambitClient;

  const first = mountConversation({
    doc,
    client: client(() => {
      firstSends += 1;
    }),
    conversationId: 'c-1',
    sessionPresent: false,
    restorePromise: neverRestored,
  });
  const second = mountConversation({
    doc,
    client: client(() => {
      secondSends += 1;
    }),
    conversationId: 'c-1',
    sessionPresent: false,
    restorePromise: neverRestored,
  });

  composer.onsubmit?.({ preventDefault: () => {} } as Event);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(firstSends, 0);
  assert.equal(secondSends, 1);
  assert.equal(input.value, '  message worth keeping  ');
  assert.equal(input.disabled, false);
  assert.equal(focused, 1);
  first.dispose();
  second.dispose();
});

test('disposing a messages controller clears conversation polling', () => {
  let cleared: ReturnType<typeof setInterval> | null = null;
  const timer = 7 as unknown as ReturnType<typeof setInterval>;
  const controller = new MessagesController({
    client: {} as unknown as GambitClient,
    callbacks: { onInbox: () => {}, onThread: () => {}, onLoading: () => {}, onError: () => {} },
    setInterval: () => timer,
    clearInterval: (id) => {
      cleared = id;
    },
  });

  controller.startPolling('c-1');
  controller.dispose();
  assert.equal(cleared, timer);
});
