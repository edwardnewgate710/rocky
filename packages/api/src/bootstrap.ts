/**
 * @packageDocumentation
 * `@chess-platform/api/pg` — the thin bootstrap layer that wires the API to real
 * Postgres-backed repositories. This is the only module that imports the `pg`
 * driver. It builds the {@link ApiDependencies} bundle (Postgres repositories +
 * scrypt hasher + HMAC token service + system clock + UUIDv7 ids) and hands it to
 * {@link createApiServer}, keeping all business logic driver-agnostic.
 */

import type { Pool } from 'pg';
import { uuidv7 } from '@chess-platform/persistence';
import type { TournamentsRepository } from '@chess-platform/persistence';
import {
  createPool,
  PgGamesRepository,
  PostgresEventStore,
  PgRatingsRepository,
  PgSeeksRepository,
  PgSessionsRepository,
  PgTournamentsRepository,
  PgUsersRepository,
  PgIdentityTokensRepository,
  PgWebAuthnCredentialsRepository,
  PgWebAuthnLoginChallengesRepository,
  PgSeekAcceptor,
  PgGameStarter,
  PgAntiCheatReportRepository,
  PgBotBehaviorReportRepository,
  PgSearchRepository,
  PgSemanticSearchRepository,
  PgSocialGraphRepository,
  PgMessagingRepository,
  PgCommunityRepository,
  PgAchievementsRepository,
  PgStudiesRepository,
  PgLearningRepository,
} from '@chess-platform/persistence/pg';
import { HashingEmbeddingProvider, SEARCH_EMBEDDING_DIMENSIONS } from '@chess-platform/search';
import type { EmbeddingProvider, SearchRepository, SemanticSearchRepository } from '@chess-platform/search';
import type { SocialGraphRepository } from '@chess-platform/social';
import type { MessagingRepository } from '@chess-platform/messaging';
import type { CommunityRepository } from '@chess-platform/community';
import type { EmailSender } from './ports/email';
import { createEmailSenderFromEnv } from './email/composition';
import { JsonLogger } from './ports/logger';
import type { Logger, LogLevel } from './ports/logger';
import { InMemoryMetrics } from './ports/metrics';
import type { Metrics } from './ports/metrics';
import { RecordingTracer, resolveTracesSampler } from './ports/tracer';
import type { Tracer } from './ports/tracer';
import { LoggingSpanExporter, MultiSpanExporter, spanSinkFromExporter } from './ports/span-export';
import {
  OtlpJsonSpanExporter,
  FetchSpanTransport,
  resolveOtlpTracesEndpoint,
} from './ports/otlp-span-exporter';
import { BatchSpanProcessor } from './ports/batch-span-processor';
import { ScryptPasswordHasher } from './auth/password';

import type { PasswordHasher } from './auth/password';
import { AccessTokenService } from './auth/tokens';
import { resolveConfig } from './config';
import type { ApiConfigInput } from './config';
import type { ApiDependencies, Repositories } from './deps';
import type { AuditEntry, AuditRepository } from './ports/audit';
import { systemClock } from './ports/clock';
import type { Clock } from './ports/clock';
import { uuidv7Generator } from './ports/ids';
import type { IdGenerator } from './ports/ids';
import { PgRateLimiter } from './ports/pg-rate-limiter';
import type { RateLimiter } from './ports/rate-limiter';
import { createApiServer } from './server';
import type { ApiServer, ApiServerOptions } from './server';
import type { GameLauncher } from './tournament/launcher';
import type { TournamentLiveView } from './tournament/live-view';
import { DurableGameLauncher } from './tournament/durable-launcher';
import { DurableTournamentLiveView } from './tournament/durable-live-view';
import type { AnalysisProvider } from '@chess-platform/engine';
import { EngineBackedEvaluator } from '@chess-platform/anti-cheat/engine';
import { AntiCheatAnalysisService } from './anti-cheat/analysis-service';
import { createAnalysisFromEnv, createMistakePrediction, createPuzzleGeneration } from './analysis/composition';
import { createAiFromEnv, createMoveExplanation } from './ai/composition';
import { EventStoreGameSource } from './anti-cheat/source';
import { EventStoreBotTimingSource } from './bot-detection/source';


/** Postgres-backed {@link AuditRepository} writing to the `audit_log` table. */
export class PgAuditRepository implements AuditRepository {
  constructor(
    private readonly pool: Pool,
    private readonly ids: IdGenerator = uuidv7Generator,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log (id, actor_id, action, target, meta, request_id, trace_id, ip, user_agent, ts)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`,
      [
        this.ids.next(),
        entry.actorId,
        entry.action,
        entry.target ?? null,
        JSON.stringify(entry.meta ?? {}),
        entry.requestId ?? null,
        entry.traceId ?? null,
        entry.ip ?? null,
        entry.userAgent ?? null,
        new Date(entry.at),
      ],
    );
  }
}

/** Construct the full Postgres-backed repository bundle from a pool. */
export function createPgRepositories(pool: Pool, ids: IdGenerator = uuidv7Generator): Repositories {
  return {
    users: new PgUsersRepository(pool),
    sessions: new PgSessionsRepository(pool),
    ratings: new PgRatingsRepository(pool),
    games: new PgGamesRepository(pool),
    seeks: new PgSeeksRepository(pool),
    audit: new PgAuditRepository(pool, ids),
    identityTokens: new PgIdentityTokensRepository(pool),
    webauthnCredentials: new PgWebAuthnCredentialsRepository(pool),
    webauthnLoginChallenges: new PgWebAuthnLoginChallengesRepository(pool),
    seekAcceptor: new PgSeekAcceptor(pool),
    gameStarter: new PgGameStarter(pool),
    antiCheat: new PgAntiCheatReportRepository(pool),
    botReports: new PgBotBehaviorReportRepository(pool),
  };
}

/** Options for the Postgres bootstrap. */
export interface PgBootstrapOptions {
  /** An existing pool; when omitted one is created from `connectionString`/`DATABASE_URL`. */
  readonly pool?: Pool;
  readonly connectionString?: string;
  readonly config?: ApiConfigInput;
  readonly hasher?: PasswordHasher;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly rateLimiter?: RateLimiter;
  readonly server?: ApiServerOptions;
  readonly tournamentRepo?: TournamentsRepository;
  readonly gameLauncher?: GameLauncher;
  readonly liveView?: TournamentLiveView;
  readonly emailSender?: EmailSender;
  /** Backs anti-cheat evaluation. Distinct from {@link PgBootstrapOptions.analysis}. */
  readonly analysisProvider?: AnalysisProvider;
  /** Engine analysis subsystem (ADR-0113). Defaults to {@link createAnalysisFromEnv}. */
  readonly analysis?: import('./analysis/composition').AnalysisComposition | undefined;
  /** AI subsystem behind Move Explanation (ADR-0115). Defaults to {@link createAiFromEnv}. */
  readonly ai?: import('./ai/composition').AiComposition | undefined;
  readonly searchRepository?: SearchRepository;
  readonly semanticSearchRepository?: SemanticSearchRepository;
  readonly embeddingProvider?: EmbeddingProvider;
  readonly socialGraphRepository?: SocialGraphRepository;
  readonly messagingRepository?: MessagingRepository;
  readonly communityRepository?: CommunityRepository;
  readonly achievementsRepository?: import('@chess-platform/achievements').AchievementsRepository;
  readonly studiesRepository?: import('@chess-platform/studies').StudiesRepository;
  readonly learningRepository?: import('@chess-platform/learning').LearningRepository;
  readonly graphql?: import('./graphql').GraphQLOptions;
  readonly logger?: Logger;
  readonly metrics?: Metrics;
  readonly tracer?: Tracer;
}

/** Resolve the log level from `LOG_LEVEL`, defaulting to `info`. */
function resolveLogLevel(): LogLevel {
  const raw = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
}

/**
 * Build the {@link ApiDependencies} bundle backed by Postgres.
 *
 * Returns `shutdownAnalysis` alongside the pool because the analysis subsystem owns engine
 * subprocesses (ADR-0113). A caller that closes the pool and exits without calling it leaves those
 * processes to be killed rather than drained.
 */
export function createPgDependencies(options: PgBootstrapOptions = {}): {
  deps: ApiDependencies;
  pool: Pool;
  shutdownAnalysis: () => Promise<void>;
} {
  const pool =
    options.pool ??
    createPool(options.connectionString ? { connectionString: options.connectionString } : {});
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? uuidv7Generator;
  const config = resolveConfig(options.config);
  const metrics = options.metrics ?? new InMemoryMetrics();
  const hasher = options.hasher ?? new ScryptPasswordHasher();
  const tokens = new AccessTokenService({
    secret: config.accessTokenSecret,
    ttlSec: config.accessTokenTtlSec,
    clock,
    ids,
  });
  const rateLimiter = options.rateLimiter ?? new PgRateLimiter(pool);
  const tournamentRepo = options.tournamentRepo ?? new PgTournamentsRepository(pool);
  const eventStore = new PostgresEventStore(pool);
  const gameLauncher = options.gameLauncher ?? new DurableGameLauncher(eventStore, clock);
  const repos = createPgRepositories(pool, ids);
  const antiCheatAnalysis = options.analysisProvider
    ? new AntiCheatAnalysisService(
        new EventStoreGameSource(eventStore),
        (variant) => new EngineBackedEvaluator(options.analysisProvider!, variant),
        repos.antiCheat,
      )
    : undefined;

  // Engine analysis (ADR-0113) on its own dedicated pool, distinct from `options.analysisProvider`
  // above — that one backs anti-cheat evaluation and is a different workload with different limits.
  // Composes only when an engine binary is configured; otherwise `deps.analysis` stays undefined,
  // `GET /v1/capabilities` reports `analysis: false`, and the route answers 503.
  const analysisComposition = options.analysis ?? createAnalysisFromEnv();

  // Move Explanation (ADR-0115) needs *both* halves: an AI provider to write the prose and the
  // analysis subsystem above to ground it. Either one missing composes nothing, which is the point
  // — an explanation with no engine behind it is exactly the unfounded verdict this feature exists
  // to prevent, so "AI configured but no engine" must not degrade into one.
  //
  // It borrows `analysisComposition.service` rather than building anything engine-shaped of its own,
  // so this adds no pool, no worker and no shutdown handle. See `ai/composition.ts` on why the AI
  // subsystem has no lifecycle to dispose.
  const aiComposition = options.ai ?? createAiFromEnv();
  const moveExplanation =
    aiComposition && analysisComposition
      ? createMoveExplanation(aiComposition, analysisComposition.service)
      : undefined;

  // Mistake Prediction (ADR-0118) needs only the analysis subsystem. Unlike Move Explanation it makes
  // no provider call at all — the classification is derived from the rules and the engine — so a
  // deployment with an engine and no AI configuration gets the whole feature rather than a degraded
  // one. It borrows the same `AnalysisService`, so this adds no pool, no worker and no shutdown
  // handle.
  const mistakePrediction = analysisComposition
    ? createMistakePrediction(analysisComposition.service)
    : undefined;
  const puzzleGeneration = analysisComposition
    ? createPuzzleGeneration(analysisComposition.service)
    : undefined;

  const searchEnabled = process.env['SEARCH_ENABLED'] !== '0';
  const searchRepository = searchEnabled
    ? (options.searchRepository ?? new PgSearchRepository(pool))
    : undefined;

  const semanticSearchEnabled = searchEnabled && process.env['SEMANTIC_SEARCH_ENABLED'] !== '0';
  const semanticSearchRepository = semanticSearchEnabled
    ? (options.semanticSearchRepository ?? new PgSemanticSearchRepository(pool))
    : undefined;
  const embeddingProvider = semanticSearchEnabled
    ? (options.embeddingProvider ?? new HashingEmbeddingProvider(SEARCH_EMBEDDING_DIMENSIONS))
    : undefined;

  const socialEnabled = process.env['SOCIAL_ENABLED'] !== '0';
  const socialGraphRepository = socialEnabled
    ? (options.socialGraphRepository ?? new PgSocialGraphRepository(pool))
    : undefined;

  const messagingEnabled = socialEnabled && process.env['MESSAGING_ENABLED'] !== '0';
  const messagingRepository = messagingEnabled && socialGraphRepository
    ? (options.messagingRepository ?? new PgMessagingRepository(pool, socialGraphRepository))
    : undefined;

  const communityEnabled = process.env['COMMUNITY_ENABLED'] !== '0';
  const communityRepository = communityEnabled
    ? (options.communityRepository ?? new PgCommunityRepository(pool))
    : undefined;

  // Opt-in, and the same flag the gateway worker reads. Defaulted on, the routes would come up
  // against any database that has not applied migration 0018 — a table that does not exist, behind
  // an endpoint that answers 200 until someone calls it. A 503 from an unconfigured subsystem is a
  // better answer than a 500 from a missing table.
  const achievementsEnabled = process.env['ACHIEVEMENTS_ENABLED'] === '1';
  const achievementsRepository = achievementsEnabled
    ? (options.achievementsRepository ?? new PgAchievementsRepository(pool))
    : undefined;

  const studiesEnabled = process.env['STUDIES_ENABLED'] === '1';
  const studiesRepository = studiesEnabled
    ? (options.studiesRepository ?? new PgStudiesRepository(pool))
    : undefined;

  const learningEnabled = process.env['LEARNING_ENABLED'] === '1';
  const learningRepository = learningEnabled
    ? (options.learningRepository ?? new PgLearningRepository(pool))
    : undefined;

  // The GraphQL layer owns no repository of its own — it reads through the optional ones above, so
  // enabling it while a subsystem is switched off yields errors on that subsystem's fields and
  // working answers everywhere else. Introspection is a second, separate opt-in (ADR-0073).
  const graphql = process.env['GRAPHQL_ENABLED'] === '1'
    ? (options.graphql ?? { introspection: process.env['GRAPHQL_INTROSPECTION'] === '1' })
    : undefined;

  const logger = options.logger ?? new JsonLogger({ service: 'api' }, { level: resolveLogLevel() });
  const logExporter = new LoggingSpanExporter(logger);
  const otlpTracesUrl = resolveOtlpTracesEndpoint(
    process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'],
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
  );
  const exporter = otlpTracesUrl
    ? new MultiSpanExporter([
        logExporter,
        new BatchSpanProcessor(
          new OtlpJsonSpanExporter(new FetchSpanTransport(otlpTracesUrl), {
            serviceName: 'api',
            scopeName: '@chess-platform/api',
            scopeVersion: '0.1.0',
          }),
          { metrics },
        ),
      ])
    : logExporter;
  // The Helm chart renders OTEL_TRACES_SAMPLER_ARG onto this Deployment (ADR-0062), so the API has
  // to honour it — otherwise the knob is documented, deployable, and silently ignored.
  const { sampler, warning: samplerWarning } = resolveTracesSampler(
    process.env['OTEL_TRACES_SAMPLER_ARG'],
  );
  if (samplerWarning) {
    logger.warn(samplerWarning);
  }
  const tracer =
    options.tracer ??
    new RecordingTracer({
      sink: spanSinkFromExporter(exporter),
      sampler,
    });

  const deps: ApiDependencies = {
    repos,
    hasher,
    tokens,
    clock,
    ids,
    config,
    rateLimiter,
    tournamentRepo,
    gameLauncher,
    liveView: options.liveView ?? new DurableTournamentLiveView(tournamentRepo, eventStore),
    emailSender: options.emailSender ?? createEmailSenderFromEnv(process.env, metrics),
    ...(antiCheatAnalysis ? { antiCheatAnalysis } : {}),
    ...(searchRepository ? { searchRepository } : {}),
    ...(semanticSearchRepository ? { semanticSearchRepository } : {}),
    ...(embeddingProvider ? { embeddingProvider } : {}),
    ...(socialGraphRepository ? { socialGraphRepository } : {}),
    ...(messagingRepository ? { messagingRepository } : {}),
    ...(communityRepository ? { communityRepository } : {}),
    ...(achievementsRepository ? { achievementsRepository } : {}),
    ...(studiesRepository ? { studiesRepository } : {}),
    ...(learningRepository ? { learningRepository } : {}),
    ...(graphql ? { graphql } : {}),
    ...(analysisComposition ? { analysis: analysisComposition.service } : {}),
    ...(moveExplanation ? { moveExplanation } : {}),
    ...(mistakePrediction ? { mistakePrediction } : {}),
    ...(puzzleGeneration ? { puzzleGeneration } : {}),
    botTimingSource: new EventStoreBotTimingSource(eventStore),
    // Production observability (M13): structured logs to stdout, a scrape
    // registry backing GET /v1/metrics, and tracer emitting spans to logs.
    logger,
    metrics,
    tracer,
    readiness: async () => {
      await pool.query('SELECT 1');
    },
  };
  return {
    deps,
    pool,
    shutdownAnalysis: async () => {
      await analysisComposition?.shutdown();
    },
  };
}

/**
 * One-call production wiring: build Postgres dependencies and the API server.
 * Returns the server, the pool, and the analysis shutdown handle so the caller can close
 * everything on shutdown.
 */
export function createPgApiServer(options: PgBootstrapOptions = {}): {
  server: ApiServer;
  pool: Pool;
  shutdownAnalysis: () => Promise<void>;
} {
  const { deps, pool, shutdownAnalysis } = createPgDependencies(options);
  const server = createApiServer(deps, options.server);
  return { server, pool, shutdownAnalysis };
}

export { uuidv7 };
