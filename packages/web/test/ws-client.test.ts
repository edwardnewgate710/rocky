import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WsClient } from '../src/net/ws-client.js';
import type { WsConnectionState } from '../src/net/ws-client.js';
import type { ServerMessage } from '../src/net/ws-protocol.js';
import { FakeSocketFactory, ManualScheduler } from './support/fake-socket.js';

function makeClient(overrides: {
  clock?: { t: number };
  reconnect?: Partial<{ enabled: boolean; maxAttempts: number; baseDelayMs: number; maxDelayMs: number; jitter: 'full' | 'none' }>;
  heartbeatMs?: number;
  heartbeatTimeoutMs?: number;
} = {}) {
  const clock = overrides.clock ?? { t: 0 };
  const factory = new FakeSocketFactory();
  const scheduler = new ManualScheduler();
  const client = new WsClient({
    url: 'wss://example.test/ws',
    factory: factory.factory,
    scheduler,
    now: () => clock.t,
    rng: () => 0,
    reconnect: { baseDelayMs: 100, maxDelayMs: 1000, jitter: 'none', ...overrides.reconnect },
    heartbeatMs: overrides.heartbeatMs ?? 0,
    heartbeatTimeoutMs: overrides.heartbeatTimeoutMs ?? 500,
  });
  return { client, factory, scheduler, clock };
}

test('connect opens a socket and transitions idle → connecting → open', () => {
  const { client, factory } = makeClient();
  const states: WsConnectionState[] = [];
  client.on({ statechange: (s) => states.push(s) });
  client.connect();
  assert.equal(client.state, 'connecting');
  factory.last.open();
  assert.equal(client.state, 'open');
  assert.deepEqual(states, ['connecting', 'open']);
});

test('send encodes only when open, else returns false', () => {
  const { client, factory } = makeClient();
  assert.equal(client.send({ t: 'ping', ts: 1 }), false); // not open yet
  client.connect();
  factory.last.open();
  assert.equal(client.send({ t: 'ping', ts: 9 }), true);
  assert.deepEqual(JSON.parse(factory.last.sent[0]!), { t: 'ping', ts: 9 });
});

test('incoming frames decode to typed messages; malformed frames emit error only', () => {
  const { client, factory } = makeClient();
  const msgs: ServerMessage[] = [];
  const errors: unknown[] = [];
  client.on({ message: (m) => msgs.push(m), error: (e) => errors.push(e) });
  client.connect();
  factory.last.open();
  factory.last.emit({ t: 'presence', gameId: 'g', white: true, black: false, spectators: 2 });
  factory.last.emit('{bad json');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0]!.t, 'presence');
  assert.equal(errors.length, 1);
});

test('pong updates rtt and is not surfaced as a message', () => {
  const clock = { t: 0 };
  const { client, factory } = makeClient({ clock });
  const msgs: ServerMessage[] = [];
  const pongs: number[] = [];
  client.on({ message: (m) => msgs.push(m), pong: (r) => pongs.push(r) });
  client.connect();
  factory.last.open();
  clock.t = 250;
  factory.last.emit({ t: 'pong', ts: 100, serverTs: 200 });
  assert.deepEqual(pongs, [150]);
  assert.equal(client.rtt, 150);
  assert.equal(client.skew, 25);
  assert.equal(msgs.length, 0);
});

test('unexpected close schedules a reconnect with backoff, then re-opens', () => {
  const { client, factory, scheduler } = makeClient();
  const reconnecting: Array<[number, number]> = [];
  client.on({ reconnecting: (attempt, delay) => reconnecting.push([attempt, delay]) });
  client.connect();
  factory.last.open();
  factory.last.serverClose(1006, '', false);
  assert.equal(client.state, 'reconnecting');
  assert.deepEqual(reconnecting, [[1, 100]]); // base 100, no jitter, first retry
  assert.equal(scheduler.pending, 1);
  scheduler.runNext();
  assert.equal(factory.sockets.length, 2);
  factory.last.open();
  assert.equal(client.state, 'open');
});

test('intentional close does not reconnect', () => {
  const { client, factory, scheduler } = makeClient();
  client.connect();
  factory.last.open();
  client.close();
  assert.equal(client.state, 'closed');
  assert.equal(scheduler.pending, 0);
  assert.ok(factory.last.closed);
});

test('reconnect gives up after maxAttempts', () => {
  const { client, factory, scheduler } = makeClient({ reconnect: { maxAttempts: 1 } });
  client.connect();
  factory.last.open();
  factory.last.serverClose(); // attempt 1 scheduled
  assert.equal(scheduler.pending, 1);
  scheduler.runNext(); // opens socket #2
  factory.last.serverClose(); // would be attempt 2 > max → give up
  assert.equal(client.state, 'closed');
  assert.equal(scheduler.pending, 0);
});

test('heartbeat pings while active and drops a silent socket', () => {
  const clock = { t: 0 };
  const { client, factory, scheduler } = makeClient({ clock, heartbeatMs: 1000, heartbeatTimeoutMs: 500 });
  client.connect();
  factory.last.open();
  const socket = factory.last;
  assert.equal(scheduler.pending, 1); // heartbeat armed
  // Since ADR-0103 the open itself pings, so the heartbeat's own ping is the second frame, not the
  // first. Asserted rather than skipped past: this is the contract change, not an off-by-one.
  assert.deepEqual(JSON.parse(socket.sent[0]!), { t: 'ping', ts: 0 });
  clock.t = 1000;
  scheduler.runNext(); // tick: still fresh → ping + re-arm
  assert.deepEqual(JSON.parse(socket.sent[1]!), { t: 'ping', ts: 1000 });
  clock.t = 2000; // no activity since t=0 → exceeds 1000 + 500
  scheduler.runNext(); // tick: stale → drop socket
  assert.deepEqual(socket.closed, { code: 4000, reason: 'heartbeat timeout' });
  assert.equal(client.state, 'reconnecting'); // close triggered reconnect
});

test('networkOffline drops the open socket into reconnect without an intentional close', () => {
  const { client, factory } = makeClient({ reconnect: { baseDelayMs: 100 } });
  client.connect();
  factory.last.open();
  const socket = factory.last;
  assert.equal(client.state, 'open');

  client.networkOffline();
  // Socket closed unexpectedly, and the client is now awaiting reconnect.
  assert.equal(socket.closed?.code, 4001);
  assert.equal(client.state, 'reconnecting');
});

test('networkOffline is a no-op when the socket is not open', () => {
  const { client } = makeClient();
  client.networkOffline(); // idle
  assert.equal(client.state, 'idle');
});

test('reconnectNow retries immediately instead of waiting out the backoff', () => {
  const { client, factory, scheduler } = makeClient({ reconnect: { baseDelayMs: 5000 } });
  client.connect();
  factory.last.open();

  client.networkOffline();
  assert.equal(client.state, 'reconnecting');
  assert.equal(scheduler.pending, 1); // a backoff timer is armed
  const offlineSocket = factory.last; // the socket that was just dropped

  client.reconnectNow(); // browser back online → retry at once
  assert.equal(scheduler.pending, 0); // backoff timer cleared
  assert.notEqual(factory.last, offlineSocket, 'reconnectNow opens a fresh socket, not the dropped one');
  factory.last.open(); // the fresh socket opens
  assert.equal(client.state, 'open');
});

test('networkOffline does not fight an intentional close', () => {
  const { client, factory } = makeClient();
  client.connect();
  factory.last.open();
  client.close();
  assert.equal(client.state, 'closed');
  client.networkOffline(); // must stay closed, no reconnect
  assert.equal(client.state, 'closed');
});

/**
 * The pong is what establishes the clock-skew estimate the live countdown interpolates against
 * (ADR-0103). Arming the heartbeat without pinging left the first `heartbeatMs` of every game
 * counting down against an unmeasured client clock — 25 seconds by default, and always the seconds
 * right after a join or reload, which is precisely when a player is watching the clock.
 */
test('opening the socket pings immediately, so skew is measured before the first heartbeat', () => {
  const { client, factory, scheduler, clock } = makeClient({ heartbeatMs: 25_000 });
  clock.t = 1_000;
  client.connect();
  factory.last.open();

  assert.deepEqual(
    JSON.parse(factory.last.sent[0]!),
    { t: 'ping', ts: 1_000 },
    'a ping must be sent on open, not only when the heartbeat interval elapses',
  );

  // And the periodic heartbeat still runs afterwards.
  clock.t = 26_000;
  scheduler.runNext();
  assert.deepEqual(JSON.parse(factory.last.sent[1]!), { t: 'ping', ts: 26_000 });
});

test('a pong answered before any heartbeat elapses yields a usable skew', () => {
  const { client, factory, clock } = makeClient({ heartbeatMs: 25_000 });
  clock.t = 1_000;
  client.connect();
  factory.last.open();
  assert.equal(client.skew, null, 'no skew before the first pong');

  clock.t = 1_040;
  factory.last.emit({ t: 'pong', ts: 1_000, serverTs: 5_020 });
  // rtt = 40, skew = serverTs - pingSentTs - rtt/2 = 5020 - 1000 - 20 = 4000.
  assert.equal(client.skew, 4_000);
});
