/**
 * @packageDocumentation
 * The dependency bundle wired into the API. Everything the services and routes
 * need arrives here explicitly (constructor injection) — there are no module-level
 * singletons, so the whole server can be constructed with in-memory fakes for
 * tests or Postgres-backed implementations in production without changing a line
 * of route or service code.
 */

import type {
  GamesRepository,
  RatingsRepository,
  SeekAcceptor,
  SeeksRepository,
  SessionsRepository,
  UsersRepository,
  TournamentsRepository,
  IdentityTokensRepository,
  WebAuthnCredentialsRepository,
  WebAuthnLoginChallengesRepository
} from '@chess-platform/persistence';
import type { PasswordHasher } from './auth/password';
import type { AccessTokenService } from './auth/tokens';
import type { AuditRepository } from './ports/audit';
import type { Clock } from './ports/clock';
import type { IdGenerator } from './ports/ids';
import type { RateLimiter } from './ports/rate-limiter';
import type { ApiConfig } from './config';
import type { GameLauncher } from './tournament/launcher';
import type { AntiCheatReportRepository, BotBehaviorReportRepository } from '@chess-platform/anti-cheat';
import type { TournamentLiveView } from './tournament/live-view';
import type { EmailSender } from './ports/email';
import type { Logger } from './ports/logger';
import type { Metrics } from './ports/metrics';
import type { Tracer } from './ports/tracer';
import type { AntiCheatAnalysisService } from './anti-cheat/analysis-service';
import type { BotGameTimingSource } from './bot-detection/source';
import type { EmbeddingProvider, SearchRepository, SemanticSearchRepository } from '@chess-platform/search';
import type { SocialGraphRepository } from '@chess-platform/social';
import type { MessagingRepository } from '@chess-platform/messaging';
import type { CommunityRepository } from '@chess-platform/community';

/** The full set of repositories the API consumes. */
export interface Repositories {
  readonly users: UsersRepository;
  readonly sessions: SessionsRepository;
  readonly ratings: RatingsRepository;
  readonly games: GamesRepository;
  readonly seeks: SeeksRepository;
  readonly audit: AuditRepository;
  readonly identityTokens: IdentityTokensRepository;
  readonly webauthnCredentials: WebAuthnCredentialsRepository;
  readonly webauthnLoginChallenges: WebAuthnLoginChallengesRepository;
  readonly seekAcceptor: SeekAcceptor;
  readonly antiCheat: AntiCheatReportRepository;
  readonly botReports: BotBehaviorReportRepository;
}

/** Everything `createApiServer` needs to construct the service. */
export interface ApiDependencies {
  readonly repos: Repositories;
  readonly hasher: PasswordHasher;
  readonly tokens: AccessTokenService;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly config: ApiConfig;
  readonly rateLimiter: RateLimiter;
  readonly tournamentRepo: TournamentsRepository;
  readonly gameLauncher: GameLauncher;
  readonly liveView: TournamentLiveView;
  readonly emailSender: EmailSender;
  readonly antiCheatAnalysis?: AntiCheatAnalysisService;
  readonly botTimingSource?: BotGameTimingSource;
  /** Optional search index (M11). When absent, `GET /v1/search` responds 503. */
  readonly searchRepository?: SearchRepository;
  /** Optional semantic/vector index (M11 inc 11). Absent => `mode=semantic|hybrid` responds 503. */
  readonly semanticSearchRepository?: SemanticSearchRepository;
  /** Embeds the query text for semantic/hybrid modes. Absent => `mode=semantic|hybrid` responds 503. */
  readonly embeddingProvider?: EmbeddingProvider;
  /** Optional social graph repository (M10 inc 2). When absent, `/v1/social/*` responds 503. */
  readonly socialGraphRepository?: SocialGraphRepository;
  /** Optional messaging repository (M10 inc 3). When absent, `/v1/messages/*` responds 503. */
  readonly messagingRepository?: MessagingRepository;
  /** Optional community repository (M10 inc 4). When absent, `/v1/teams/*` and `/v1/forum/*` respond 503. */
  readonly communityRepository?: CommunityRepository;
  /** Structured logger (M13). Defaults to a silent {@link NullLogger}. */
  readonly logger?: Logger;
  /** Metrics registry + scrape target (M13). Defaults to {@link InMemoryMetrics}. */
  readonly metrics?: Metrics;
  /** Distributed-tracing tracer (M13). Defaults to a silent {@link NullTracer}. */
  readonly tracer?: Tracer;
  /** Production dependency check used by the readiness endpoint. */
  readonly readiness?: () => Promise<void>;
}


