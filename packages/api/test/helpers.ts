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
import { InMemoryEventStore } from '@chess-platform/persistence';
import type { PositionEvaluator } from '@chess-platform/anti-cheat';
import { AntiCheatAnalysisService } from '../src/anti-cheat/analysis-service';
import { EventStoreGameSource } from '../src/anti-cheat/source';
import { EventStoreBotTimingSource } from '../src/bot-detection/source';
import type { Logger } from '../src/ports/logger';
import type { Tracer } from '../src/ports/tracer';
import {
  HashingEmbeddingProvider,
  InMemorySearchRepository,
  InMemorySemanticSearchRepository,
  SEARCH_EMBEDDING_DIMENSIONS,
} from '@chess-platform/search';
import { InMemorySocialGraphRepository } from '@chess-platform/social';
import { InMemoryMessagingRepository } from '@chess-platform/messaging';
import { InMemoryCommunityRepository } from '@chess-platform/community';
import { InMemoryAchievementsRepository } from '@chess-platform/achievements';


export const TEST_SECRET = 'test-access-token-secret-0123456789abcdef';
export const START_MS = 1_700_000_000_000;

// WHATWG Fetch blocks several legacy-service ports even on localhost. Windows
// can allocate them from a low ephemeral range, so discard those assignments.
const FETCH_BLOCKED_EPHEMERAL_PORTS = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

export interface Harness {
  readonly server: ApiServer;
  readonly repos: InMemoryRepositories;
  readonly tournamentRepo: InMemoryTournamentsRepository;
  readonly antiCheatEventStore: InMemoryEventStore;
  readonly searchRepository?: InMemorySearchRepository;
  readonly semanticSearchRepository?: InMemorySemanticSearchRepository;
  readonly embeddingProvider?: HashingEmbeddingProvider;
  readonly socialGraphRepository?: InMemorySocialGraphRepository;
  readonly messagingRepository?: InMemoryMessagingRepository;
  readonly communityRepository?: InMemoryCommunityRepository;
  readonly achievementsRepository?: InMemoryAchievementsRepository;
  readonly studiesRepository?: import('@chess-platform/studies').StudiesRepository;
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

/** Extra server dependencies a test may override (beyond the config). */
export interface HarnessOptions {
  /** Readiness probe backing `/v1/ready`; default resolves (healthy). */
  readonly readiness?: () => Promise<void>;
  /** Structured logger; inject a capturing one to assert on log output. */
  readonly logger?: Logger;
  /** Tracer; inject a capturing one to assert on span emission. */
  readonly tracer?: Tracer;
  /** Pass true to simulate a server constructed without an anti-cheat analysis service. */
  readonly withoutAntiCheatAnalysis?: boolean;
  /** Pass true to simulate a server constructed without search. */
  readonly withoutSearch?: boolean;
  /** Pass true to simulate a server constructed without semantic search. */
  readonly withoutSemanticSearch?: boolean;
  /** Pass true to simulate a server constructed without social graph repository. */
  readonly withoutSocial?: boolean;
  /** Pass true to simulate a server constructed without messaging repository. */
  readonly withoutMessaging?: boolean;
  /** Pass true to simulate a server constructed without community repository. */
  readonly withoutCommunity?: boolean;
  /** Pass true to simulate a server constructed without achievements repository. */
  readonly withoutAchievements?: boolean;
  /** Pass true to simulate a server constructed without studies repository. */
  readonly withoutStudies?: boolean;
  /** Override the anti-cheat evaluator (e.g. to make it throw) for edge-case tests. */
  readonly antiCheatEvaluator?: PositionEvaluator;
}

export async function startHarness(
  config: ApiConfigInput = {},
  harnessOptions: HarnessOptions = {},
): Promise<Harness> {
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
  const fakeEvaluator: PositionEvaluator = {
    evaluate: (_fen, playedUci) => ({
      topMoves: [
        { uci: playedUci, cp: 30 },
        { uci: '0000', cp: 10 },
      ],
      playedCp: 30,
    }),
  };
  const antiCheatEventStore = new InMemoryEventStore();
  const antiCheatEvaluator = harnessOptions.antiCheatEvaluator ?? fakeEvaluator;
  const antiCheatAnalysis = harnessOptions.withoutAntiCheatAnalysis
    ? undefined
    : new AntiCheatAnalysisService(
        new EventStoreGameSource(antiCheatEventStore),
        () => antiCheatEvaluator,
        repos.antiCheat,
      );
  const searchRepository = harnessOptions.withoutSearch
    ? undefined
    : new InMemorySearchRepository();
  const semanticSearchRepository = harnessOptions.withoutSemanticSearch
    ? undefined
    : new InMemorySemanticSearchRepository();
  const embeddingProvider = harnessOptions.withoutSemanticSearch
    ? undefined
    : new HashingEmbeddingProvider(SEARCH_EMBEDDING_DIMENSIONS);
  const socialGraphRepository = harnessOptions.withoutSocial
    ? undefined
    : new InMemorySocialGraphRepository();
  const messagingRepository = harnessOptions.withoutMessaging || !socialGraphRepository
    ? undefined
    : new InMemoryMessagingRepository(socialGraphRepository);
  const communityRepository = harnessOptions.withoutCommunity
    ? undefined
    : new InMemoryCommunityRepository();
  const achievementsRepository = harnessOptions.withoutAchievements
    ? undefined
    : new InMemoryAchievementsRepository();
  const studiesRepository = harnessOptions.withoutStudies
    ? undefined
    : repos.studies;
  const server = createApiServer({
    repos, hasher, tokens, clock, ids, rateLimiter, tournamentRepo, gameLauncher, liveView, emailSender,
    config: resolved,
    botTimingSource: new EventStoreBotTimingSource(antiCheatEventStore),
    ...(antiCheatAnalysis ? { antiCheatAnalysis } : {}),
    ...(searchRepository ? { searchRepository } : {}),
    ...(semanticSearchRepository ? { semanticSearchRepository } : {}),
    ...(embeddingProvider ? { embeddingProvider } : {}),
    ...(socialGraphRepository ? { socialGraphRepository } : {}),
    ...(messagingRepository ? { messagingRepository } : {}),
    ...(communityRepository ? { communityRepository } : {}),
    ...(achievementsRepository ? { achievementsRepository } : {}),
    ...(studiesRepository ? { studiesRepository } : {}),
    ...(harnessOptions.readiness ? { readiness: harnessOptions.readiness } : {}),
    ...(harnessOptions.logger ? { logger: harnessOptions.logger } : {}),
    ...(harnessOptions.tracer ? { tracer: harnessOptions.tracer } : {}),
  });
  let http: Server;
  let port: number;
  do {
    http = await server.listen(0, '127.0.0.1');
    ({ port } = http.address() as AddressInfo);
    if (FETCH_BLOCKED_EPHEMERAL_PORTS.has(port)) await closeServer(http);
  } while (FETCH_BLOCKED_EPHEMERAL_PORTS.has(port));
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    server,
    repos,
    tournamentRepo,
    antiCheatEventStore,
    searchRepository,
    semanticSearchRepository,
    embeddingProvider,
    socialGraphRepository,
    messagingRepository,
    communityRepository,
    achievementsRepository,
    studiesRepository,
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
    close: () => closeServer(http),
  };
}
