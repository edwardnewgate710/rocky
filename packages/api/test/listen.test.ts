/**
 * Tests for ephemeral-port acquisition (ADR-0140).
 *
 * The defect these cover is not a logic slip but a runtime policy: `fetch`
 * refuses a set of ports outright, so a harness handed one binds cleanly and
 * then fails at its first request. Two of the cases below therefore talk to the
 * real runtime rather than to a stub — one proves `fetch` really does refuse a
 * port while a server is really listening on it, and one drives the retry with
 * real listeners on real blocked ports. Everything the seam-driven cases assert
 * about bounds and cleanup rests on those two.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import {
  DEFAULT_MAX_LISTEN_ATTEMPTS,
  FETCH_BLOCKED_PORTS,
  closeServer,
  isFetchBlockedPort,
  listenOnFetchablePort,
} from './listen';
import { startHarness } from './helpers';

const HOST = '127.0.0.1';

/** Blocked ports to try when a case needs a real listener on one. */
const BLOCKED_CANDIDATES = [6666, 6667, 6668, 6669, 6679, 6665] as const;

/** Bind a real HTTP server, or `undefined` if the port is unavailable here. */
async function tryListen(port: number): Promise<Server | undefined> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, HOST, resolve);
    });
    return server;
  } catch {
    return undefined;
  }
}

/** The first blocked port this machine will actually let us bind. */
async function listenOnSomeBlockedPort(): Promise<{ server: Server; port: number } | undefined> {
  for (const port of BLOCKED_CANDIDATES) {
    const server = await tryListen(port);
    if (server) return { server, port };
  }
  return undefined;
}

/** Speak HTTP over a raw socket, bypassing `fetch` and its port policy entirely. */
function rawHttpStatusLine(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, HOST, () => socket.write('GET / HTTP/1.0\r\n\r\n'));
    let received = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('raw HTTP probe timed out')));
    socket.on('data', (chunk) => (received += chunk));
    socket.on('end', () => resolve(received.split('\r\n')[0] ?? ''));
    socket.on('error', reject);
  });
}

/** Whether anything is accepting connections on a port. */
function isRefused(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, HOST, () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(5000, () => socket.destroy(new Error('connect probe timed out')));
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED') resolve(true);
      else reject(err);
    });
  });
}

/** The `cause` message `fetch` failed with, or `undefined` if it did not fail. */
async function fetchFailureCause(port: number): Promise<string | undefined> {
  try {
    await fetch(`http://${HOST}:${port}/`);
    return undefined;
  } catch (error) {
    const cause = (error as { cause?: Error }).cause;
    return cause?.message ?? (error as Error).message;
  }
}

// --- The real runtime boundary -------------------------------------------
// Contract 2's foundation: without these, every case below could pass against
// a set of port numbers that means nothing to the runtime.

test('fetch refuses a blocked port while a server is genuinely listening on it', async (t) => {
  const listening = await listenOnSomeBlockedPort();
  if (!listening) {
    t.skip('no WHATWG-blocked port was bindable on this host');
    return;
  }
  const { server, port } = listening;
  try {
    // The server is not merely bound: it answers a real HTTP request, so the
    // fetch failure below cannot be blamed on a dead listener.
    assert.equal(server.listening, true);
    assert.match(await rawHttpStatusLine(port), /^HTTP\/1\.[01] 200/);

    const cause = await fetchFailureCause(port);
    assert.equal(cause, 'bad port', `fetch should refuse port ${port} by policy`);
  } finally {
    await closeServer(server);
  }
});

test('the blocked-port set is the whole WHATWG table, not an observed subset', () => {
  // A second, independent transcription of the specification's table. Both this
  // and the module's copy were checked against the runtime once, by probing
  // every port from 1 to 65535 through `fetch`; that sweep is deliberately not
  // run here, because ~14000 refused connections would churn through more
  // ephemeral ports than a Windows 1024-15000 range holds, which is the very
  // condition these tests exist to keep out of the suite.
  //
  // Keeping the list twice is the point: the defect this replaced was a set
  // trimmed to the ports one machine happened to observe, and `6679` went
  // missing from it unnoticed.
  const whatwgBadPorts = [
    1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
    87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
    137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
    532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
    1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667,
    6668, 6669, 6679, 6697, 10080,
  ];
  assert.deepEqual([...FETCH_BLOCKED_PORTS].sort((a, b) => a - b), whatwgBadPorts);
  // The one that was missing, called out so a future trim cannot pass quietly.
  assert.equal(isFetchBlockedPort(6679), true);
});

test('every port the module lists is one the runtime actually refuses', async () => {
  // Nothing is listening, so a port the runtime does not block reports a
  // connection failure instead — `bad port` can only come from the policy.
  const notRefused: number[] = [];
  for (const port of FETCH_BLOCKED_PORTS) {
    if ((await fetchFailureCause(port)) !== 'bad port') notRefused.push(port);
  }
  assert.deepEqual(notRefused, [], 'listed ports the runtime does not refuse');
});

test('an ordinary ephemeral port is not refused by the port policy', async () => {
  const harness = await startHarness();
  const port = Number(new URL(harness.baseUrl).port);
  await harness.close();

  // Now closed, so this cannot connect — but the reason must be a refused
  // connection, not the port policy.
  assert.equal(isFetchBlockedPort(port), false);
  assert.notEqual(await fetchFailureCause(port), 'bad port');
});

// --- Retry over real listeners on real blocked ports ----------------------

test('a blocked port is rejected, closed, and never returned as usable', async (t) => {
  const first = await listenOnSomeBlockedPort();
  if (!first) {
    t.skip('no WHATWG-blocked port was bindable on this host');
    return;
  }
  await closeServer(first.server);

  const events: string[] = [];
  let attempt = 0;
  const listening = await listenOnFetchablePort(async (port, host) => {
    attempt++;
    if (attempt === 1) {
      const blocked = await tryListen(first.port);
      assert.ok(blocked, 'the blocked port was bindable a moment ago');
      events.push(`listen:${first.port}`);
      blocked.once('close', () => events.push(`close:${first.port}`));
      return blocked;
    }
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(port, host, resolve));
    events.push('listen:ephemeral');
    return server;
  }, HOST);

  try {
    assert.equal(attempt, 2, 'the blocked port should have cost exactly one retry');
    assert.notEqual(listening.port, first.port);
    assert.equal(isFetchBlockedPort(listening.port), false);
    // The rejected listener was closed before the next one was asked for.
    assert.deepEqual(events, [`listen:${first.port}`, `close:${first.port}`, 'listen:ephemeral']);
    assert.equal(await isRefused(first.port), true, 'the rejected port must be released');
    // And the port it did return is genuinely usable through `fetch`.
    const response = await fetch(`http://${HOST}:${listening.port}/`);
    assert.equal(response.status, 200);
    await response.text();
  } finally {
    await closeServer(listening.server);
  }
});

// --- Bounds, exhaustion and cleanup --------------------------------------

/** A listener seam that always yields a real server on a port we dictate. */
function seamReturning(ports: readonly number[]): {
  listen: (port: number, host: string) => Promise<Server>;
  opened: Server[];
  closed: number[];
  calls: () => number;
} {
  const opened: Server[] = [];
  const closed: number[] = [];
  let call = 0;
  return {
    opened,
    closed,
    calls: () => call,
    listen: async (_port, host) => {
      const want = ports[Math.min(call, ports.length - 1)] ?? 0;
      call++;
      const server = createServer((_req, res) => res.end('ok'));
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        // A blocked port is bound for real where possible; where the host will
        // not give it to us the address is reported instead, which is enough to
        // drive the decision under test.
        server.listen(0, host, resolve);
      });
      const actual = (server.address() as { port: number }).port;
      if (want !== 0) {
        Object.defineProperty(server, 'address', { value: () => ({ address: host, family: 'IPv4', port: want }) });
      }
      server.once('close', () => closed.push(want || actual));
      opened.push(server);
      return server;
    },
  };
}

test('retrying is bounded and exhaustion reports the ports it rejected', async () => {
  const seam = seamReturning([6666]);
  await assert.rejects(
    () => listenOnFetchablePort(seam.listen, HOST, { maxAttempts: 4 }),
    (error: Error) => {
      assert.match(error.message, /could not bind an ephemeral port/);
      assert.match(error.message, /4 attempts/);
      assert.match(error.message, /6666/);
      return true;
    },
  );
  assert.equal(seam.calls(), 4, 'the loop must stop at the bound, not run on');
  assert.deepEqual(seam.closed, [6666, 6666, 6666, 6666], 'every rejected listener is closed');
  for (const server of seam.opened) assert.equal(server.listening, false);
});

test('the retry bound defaults to a documented, finite value', async () => {
  assert.equal(Number.isInteger(DEFAULT_MAX_LISTEN_ATTEMPTS), true);
  assert.ok(DEFAULT_MAX_LISTEN_ATTEMPTS >= 1 && DEFAULT_MAX_LISTEN_ATTEMPTS <= 100);

  const seam = seamReturning([6666]);
  await assert.rejects(() => listenOnFetchablePort(seam.listen, HOST));
  assert.equal(seam.calls(), DEFAULT_MAX_LISTEN_ATTEMPTS);
});

test('a run of blocked ports is survived and the first usable one is returned', async () => {
  const seam = seamReturning([6666, 6667, 6668, 0]);
  const listening = await listenOnFetchablePort(seam.listen, HOST, { maxAttempts: 10 });
  try {
    assert.equal(seam.calls(), 4);
    assert.deepEqual(seam.closed, [6666, 6667, 6668]);
    assert.equal(isFetchBlockedPort(listening.port), false);
    assert.equal(listening.server.listening, true);
  } finally {
    await closeServer(listening.server);
  }
});

test('a listener reporting no usable address is closed rather than leaked', async () => {
  let opened: Server | undefined;
  await assert.rejects(
    () =>
      listenOnFetchablePort(async (_port, host) => {
        const server = createServer();
        await new Promise<void>((resolve) => server.listen(0, host, resolve));
        Object.defineProperty(server, 'address', { value: () => null });
        opened = server;
        return server;
      }, HOST),
    /expected an ephemeral TCP port/,
  );
  assert.equal(opened?.listening, false, 'the listener must not be left open');
});

test('a nonsensical retry bound is refused outright', async () => {
  let called = false;
  const listen = async (): Promise<Server> => {
    called = true;
    throw new Error('should not be reached');
  };
  await assert.rejects(
    () => listenOnFetchablePort(listen, HOST, { maxAttempts: 0 }),
    /maxAttempts must be a positive integer/,
  );
  assert.equal(called, false);
});

// --- What the harness hands to its callers -------------------------------

test('startHarness serves over an unblocked port and its URL is a plain IPv4 origin', async () => {
  const harness = await startHarness();
  try {
    assert.match(harness.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    const port = Number(new URL(harness.baseUrl).port);
    assert.equal(isFetchBlockedPort(port), false);
    assert.notEqual(port, 0);

    const { status } = await harness.json('GET', '/v1/capabilities');
    assert.equal(status, 200);
  } finally {
    await harness.close();
  }
});

test('concurrent harnesses never share a port', async () => {
  const harnesses = await Promise.all([startHarness(), startHarness(), startHarness()]);
  try {
    const ports = harnesses.map((h) => Number(new URL(h.baseUrl).port));
    assert.equal(new Set(ports).size, ports.length, 'each harness needs its own listener');
    for (const port of ports) assert.equal(isFetchBlockedPort(port), false);

    const statuses = await Promise.all(
      harnesses.map(async (h) => (await h.json('GET', '/v1/capabilities')).status),
    );
    assert.deepEqual(statuses, [200, 200, 200]);
  } finally {
    await Promise.all(harnesses.map((h) => h.close()));
  }
});

test('a bind that fails rejects, rather than hanging the acquisition it feeds', async () => {
  // `listenOnFetchablePort` promises a bounded, diagnosable failure, and it can
  // only keep that promise if the listener it is given rejects. `ApiServer.listen`
  // reported a bind failure as an unhandled `error` event on the server and left
  // its promise pending forever, so an EADDRINUSE or EMFILE hung the harness and
  // took the process down instead. Raised by the Qodo review of PR #21.
  const harness = await startHarness();
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, HOST, resolve));
  const taken = (blocker.address() as AddressInfo).port;

  try {
    // Raced against a deadline rather than simply awaited: the defect is a
    // promise that never settles, and awaiting one of those hangs the whole run
    // instead of reporting it. The timer is a reporting guard, not the thing
    // under test — the assertion below still demands a real EADDRINUSE.
    const HUNG = Symbol('hung');
    const outcome = await Promise.race([
      harness.server.listen(taken, HOST).then(
        () => new Error('bind unexpectedly succeeded on a port already in use'),
        (error: unknown) => error,
      ),
      new Promise<typeof HUNG>((resolve) => setTimeout(() => resolve(HUNG), 5000).unref()),
    ]);

    assert.notEqual(outcome, HUNG, 'a failed bind must settle the promise, not hang it');
    assert.equal((outcome as NodeJS.ErrnoException).code, 'EADDRINUSE');
  } finally {
    await closeServer(blocker);
    await harness.close();
  }
});

test('closing a harness releases its port, and closing twice reports it as already stopped', async () => {
  const harness = await startHarness();
  const port = Number(new URL(harness.baseUrl).port);

  await harness.close();
  assert.equal(await isRefused(port), true, 'the listener must be gone');

  // The pre-existing contract: `closeServer` forwards the callback's error, and
  // Node reports a second close as ERR_SERVER_NOT_RUNNING.
  await assert.rejects(() => harness.close(), { code: 'ERR_SERVER_NOT_RUNNING' });
});
