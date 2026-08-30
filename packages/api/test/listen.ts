/**
 * Ephemeral-port acquisition for the API test harnesses.
 *
 * `server.listen(0)` asks the OS for any free port, and on a host whose dynamic
 * range reaches low enough the OS can hand back one that WHATWG Fetch refuses
 * to speak to. The bind itself succeeds and the server answers raw TCP
 * normally — it is `fetch` that declines, before it opens a socket — so the
 * failure surfaces at the harness's *first request* as
 * `TypeError: fetch failed` with `cause` `Error: bad port`, with a stack
 * pointing at the request rather than at the listen that caused it.
 *
 * Windows is where this bites: a default Linux range (32768–60999) contains no
 * blocked port, while a Windows range starting at 1024 contains nineteen of
 * them. That is why the same suite is green on CI and flaky on a developer
 * machine, and why the reproduction here cannot be left to chance.
 *
 * This module is the single place that knows which ports those are and how to
 * trade a rejected one in for a usable one.
 */

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Every port WHATWG Fetch refuses, from the specification's "bad ports" table.
 *
 * Kept spec-complete rather than trimmed to the ports one machine's ephemeral
 * range happens to reach. The previous hand-tuned subset was the whole list
 * intersected with a 1024–15000 range, which made it correct only for the
 * machine it was written on and left a live gap even there: `6679` belongs to
 * that intersection and was missing, so a harness handed 6679 sailed past the
 * guard and failed at its first request. A list derived from the spec cannot
 * drift with someone's `netsh` settings.
 *
 * Verified against the runtime rather than transcribed on faith: sweeping every
 * port from 1 to 65535 through `fetch` on Node v24.15.0 rejects exactly these
 * eighty-two with `bad port` and no others.
 */
export const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

/** Whether `fetch` would refuse a URL on this port, whatever is listening on it. */
export const isFetchBlockedPort = (port: number): boolean => FETCH_BLOCKED_PORTS.has(port);

/**
 * How many ephemeral ports to try before giving up.
 *
 * The bound exists to make a broken environment fail loudly instead of hanging
 * a suite forever; it is not tuned for the odds, which are not close. The worst
 * case among ordinary configurations is a Windows range of 1024–15000, where
 * nineteen of 13977 ports are blocked — so a single draw fails about 0.14% of
 * the time and twenty consecutive failures sits around 1e-58. Any real
 * exhaustion is therefore a host that cannot allocate ports at all, which is
 * worth an error rather than another attempt.
 */
export const DEFAULT_MAX_LISTEN_ATTEMPTS = 20;

/**
 * Wait for a listener to actually stop, rather than only asking it to.
 *
 * `Server.close` is callback-shaped and reports failure there, so returning
 * before it settles would leak the socket into the next attempt.
 */
export const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

/** Close a listener we are already abandoning, without losing the reason we abandoned it. */
async function closeWithoutMasking(server: Server): Promise<void> {
  try {
    await closeServer(server);
  } catch {
    // The caller is already unwinding with a more useful error; a secondary
    // close failure must not replace it.
  }
}

/** Read the bound port, rejecting the shapes `address()` can return that have none. */
function boundPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    // `null` means the socket is not (or no longer) listening; a string means a
    // pipe or Unix socket. Both would otherwise sail through `as AddressInfo`
    // and produce a `baseUrl` ending in `:undefined`.
    throw new Error(
      `expected an ephemeral TCP port but the listener reported ${
        address === null ? 'no address' : `the non-TCP address ${JSON.stringify(address)}`
      }`,
    );
  }
  return (address satisfies AddressInfo).port;
}

export interface ListenOptions {
  /** Attempts before giving up. Defaults to {@link DEFAULT_MAX_LISTEN_ATTEMPTS}. */
  readonly maxAttempts?: number;
}

export interface Listening {
  readonly server: Server;
  readonly port: number;
}

/**
 * Bind an ephemeral port that `fetch` will actually talk to.
 *
 * `listen` is supplied by the caller rather than taken as a bound server so the
 * retry can ask for a *fresh* port each attempt; `ApiServer.listen` already
 * builds a new `http.Server` per call, so no listener is ever re-bound.
 *
 * Ordering is what makes the retry race-free: a rejected listener is closed
 * before the next attempt asks for another port, and the port that is finally
 * returned is one this harness still holds. Nothing pre-binds a port and hands
 * it on for someone else to race for.
 */
export async function listenOnFetchablePort(
  listen: (port: number, host: string) => Promise<Server>,
  host: string,
  options: ListenOptions = {},
): Promise<Listening> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_LISTEN_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`maxAttempts must be a positive integer, got ${String(maxAttempts)}`);
  }

  const rejected: number[] = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const server = await listen(0, host);

    let port: number;
    try {
      port = boundPort(server);
    } catch (error) {
      await closeWithoutMasking(server);
      throw error;
    }

    if (!isFetchBlockedPort(port)) return { server, port };

    rejected.push(port);
    // Closed before the next attempt, so at most one listener is ever open.
    await closeServer(server);
  }

  throw new Error(
    `could not bind an ephemeral port on ${host} that fetch accepts: ` +
      `${maxAttempts} attempts all drew a WHATWG-blocked port (${rejected.join(', ')}). ` +
      `Ports blocked by fetch that this host can hand out are a property of its dynamic ` +
      `port range; widening the range (Windows: 'netsh int ipv4 set dynamicport tcp') ` +
      `makes them proportionally rarer.`,
  );
}
