/**
 * Test harness: constructs a fully in-memory API server on an ephemeral port and
 * exposes helpers for authenticated and anonymous requests. Uses a low scrypt
 * cost and a manual clock so tests are fast and deterministic.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Role } from '@chess-platform/persistence';
import { ScryptPasswordHasher } from '../src/auth/password';
import { AccessTokenService } from '../src/auth/tokens';
import { resolveConfig } from '../src/config';
import type { ApiConfigInput } from '../src/config';
import { createInMemoryRepositories, InMemoryTournamentsRepository } from '../src/fakes';
import type { InMemoryRepositories } from '../src/fakes';
import { ManualClock } from '../src/ports/clock';
import { uuidv7Generator } from '../src/ports/ids';
import { InMemoryRateLimiter } from '../src/ports/in-memory-rate-limiter';
import { createApiServer } from '../src/server';
import type { ApiServer } from '../src/server';
import { InMemoryGameLauncher } from '../src/tournament/launcher';
import { InMemoryEmailSender } from '../src/ports/email';

export const TEST_SECRET = 'test-access-token-secret-0123456789abcdef';
export const START_MS = 1_700_000_000_000;

export interface Harness {
  readonly server: ApiServer;
  readonly repos: InMemoryRepositories;
  readonly tournamentRepo: InMemoryTournamentsRepository;
  readonly clock: ManualClock;
  readonly tokens: AccessTokenService;
  readonly emailSender: InMemoryEmailSender;
  readonly baseUrl: string;
  makeUser(handle: string, roles?: Role[]): Promise<{ userId: string; token: string }>;
  json(
    method: string,
    path: string,
    opts?: { body?: unknown; token?: string; headers?: Record<string, string> },
  ): Promise<{ status: number; body: any; headers: Headers }>;
  close(): Promise<void>;
}

export async function startHarness(config: ApiConfigInput = {}): Promise<Harness> {
  const clock = new ManualClock(START_MS);
  const ids = uuidv7Generator;
  const resolved = resolveConfig({
    accessTokenSecret: TEST_SECRET,
    accessTokenTtlSec: 900,
    refreshTokenTtlSec: 3600,
    cookieSecure: false, // tests run over plain HTTP
    ...config,
  });
  const tokens = new AccessTokenService({
    secret: resolved.accessTokenSecret,
    ttlSec: resolved.accessTokenTtlSec,
    clock,
    ids,
  });
  const repos = createInMemoryRepositories(clock);
  const tournamentRepo = new InMemoryTournamentsRepository();
  const hasher = new ScryptPasswordHasher({ N: 1024 }); // low cost for test speed
  const rateLimiter = new InMemoryRateLimiter(clock);
  const gameLauncher = new InMemoryGameLauncher(ids);
  const liveView = { activeGames: () => [] };
  const emailSender = new InMemoryEmailSender();
  const server = createApiServer({ repos, hasher, tokens, clock, ids, rateLimiter, tournamentRepo, gameLauncher, liveView, emailSender, config: resolved });
  const http: Server = await server.listen(0, '127.0.0.1');
  const { port } = http.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    server,
    repos,
    tournamentRepo,
    clock,
    tokens,
    emailSender,
    baseUrl,
    async makeUser(handle, roles = ['user']) {
      const user = await repos.users.create({ id: ids.next(), handle });
      for (const r of roles) await repos.users.addRole(user.id, r);
      const { token } = tokens.issue({ userId: user.id, handle, roles });
      return { userId: user.id, token };
    },
    async json(method, path, opts = {}) {
      const headers: Record<string, string> = {};
      if (opts.body !== undefined) headers['content-type'] = 'application/json';
      if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
      Object.assign(headers, opts.headers ?? {});
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      const text = await res.text();
      const body = text ? JSON.parse(text) : undefined;
      return { status: res.status, body, headers: res.headers };
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        http.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
