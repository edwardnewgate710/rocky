/**
 * @packageDocumentation
 * The composition root. {@link createApiServer} takes an explicit dependency
 * bundle (repositories, password hasher, token service, clock, id generator,
 * config) and returns a ready-to-serve handler plus helpers. It performs the
 * only wiring in the package: constructing the {@link AuthService}, building the
 * route table, and adapting the router to a Node `http` listener with a
 * bearer-token authenticator. Nothing here reads globals — a test wires fakes,
 * production wires Postgres, and the code in between is identical.
 */

import { createServer, type RequestListener, type Server } from 'node:http';
import { AuthService } from './auth/service';
import type { ApiDependencies } from './deps';
import { HttpError } from './http/errors';
import type { Identity } from './http/context';
import { Router } from './http/router';
import { withSecurity } from './http/security';
import { buildRouter } from './routes';
import { NullLogger } from './ports/logger';
import { InMemoryMetrics } from './ports/metrics';
import { NullTracer } from './ports/tracer';
import type { OpenApiDocument, OpenApiInfo } from './openapi/spec';
import { buildOpenApiDocument } from './openapi/spec';

/** Options that shape the served metadata (title/version/servers). */
export interface ApiServerOptions {
  readonly info?: Partial<OpenApiInfo>;
}

/** The constructed API surface. */
export interface ApiServer {
  /** Node `http` request listener. */
  readonly handler: RequestListener;
  /** The route table (useful for tests and tooling). */
  readonly router: Router;
  /** The identity service (exposed for advanced composition). */
  readonly auth: AuthService;
  /** Build (and return) the OpenAPI document for this server. */
  openapiDocument(): OpenApiDocument;
  /** Start an HTTP server on `port`; resolves once listening. */
  listen(port: number, host?: string): Promise<Server>;
}

const DEFAULT_INFO: OpenApiInfo = {
  title: 'Gambit API',
  version: '0.1.0',
  description: 'Gambit REST API — identity, sessions, seeks, ratings, and games.',
};

/** Wire the API from an explicit dependency bundle. */
export function createApiServer(deps: ApiDependencies, options: ApiServerOptions = {}): ApiServer {
  const info: OpenApiInfo = { ...DEFAULT_INFO, ...options.info };

  // Observability (M13): one metrics registry is shared between the per-request
  // recorder (RouterRuntime) and the /v1/metrics render route so both see the
  // same series. Logger defaults to silent; production roots inject a JsonLogger.
  // Tracer defaults to silent NullTracer; production roots inject a RecordingTracer.
  const logger = deps.logger ?? new NullLogger();
  const metrics = deps.metrics ?? new InMemoryMetrics();
  const tracer = deps.tracer ?? new NullTracer();

  const auth = new AuthService({
    repos: deps.repos,
    hasher: deps.hasher,
    tokens: deps.tokens,
    clock: deps.clock,
    ids: deps.ids,
    refreshTtlSec: deps.config.refreshTokenTtlSec,
    emailSender: deps.emailSender,
    webauthn: deps.config.webauthn,

  });

  const router = buildRouter({
    auth,
    repos: deps.repos,
    clock: deps.clock,
    ids: deps.ids,
    info,
    rateLimiter: deps.rateLimiter,
    config: deps.config,
    tournamentRepo: deps.tournamentRepo,
    gameLauncher: deps.gameLauncher,
    liveView: deps.liveView,
    metrics,
    tracer,
    readiness: deps.readiness ?? (() => Promise.resolve()),
    antiCheatAnalysis: deps.antiCheatAnalysis,
    botTimingSource: deps.botTimingSource,
    searchRepository: deps.searchRepository,
    semanticSearchRepository: deps.semanticSearchRepository,
    embeddingProvider: deps.embeddingProvider,
    socialGraphRepository: deps.socialGraphRepository,
    messagingRepository: deps.messagingRepository,
    communityRepository: deps.communityRepository,
    achievementsRepository: deps.achievementsRepository,
    studiesRepository: deps.studiesRepository,
    learningRepository: deps.learningRepository,
    graphql: deps.graphql,
    analysis: deps.analysis,
    moveExplanation: deps.moveExplanation,
    mistakePrediction: deps.mistakePrediction,
    puzzleGeneration: deps.puzzleGeneration,
    openingExploration: deps.openingExploration,
  });

  const authenticate = (authorization: string | undefined): Identity | null => {
    if (!authorization) return null;
    const match = /^Bearer (.+)$/i.exec(authorization.trim());
    if (!match) throw HttpError.unauthorized('malformed Authorization header');
    const identity = deps.tokens.identify(match[1]!);
    if (!identity) throw HttpError.unauthorized('invalid or expired access token');
    return identity;
  };

  const routerListener = router.toListener({
    authenticate,
    maxBodyBytes: deps.config.maxBodyBytes,
    trustProxy: deps.config.trustProxy,
    newRequestId: () => deps.ids.next(),
    logger,
    metrics,
    tracer,
  });

  // Wrap the router listener with security headers and CORS enforcement.
  // Security headers and CORS preflight short-circuit happen before the router
  // is invoked, so they apply to every response including 404/405/422/500.
  const handler = withSecurity(routerListener, {
    cors: deps.config.cors,
    enableHsts: deps.config.enableHsts,
  });

  return {
    handler,
    router,
    auth,
    openapiDocument: () => buildOpenApiDocument(router, info),
    listen: (port: number, host?: string): Promise<Server> =>
      new Promise((resolve) => {
        const server = createServer(handler);
        server.listen(port, host, () => resolve(server));
      }),
  };
}
