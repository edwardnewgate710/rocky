/**
 * @packageDocumentation
 * The route table. Each route couples its OpenAPI contract, its auth policy, and
 * its handler, so the served behavior and the published spec come from one
 * definition. Handlers stay thin: validate input, call a service/repository,
 * present the result. All collaborators arrive via {@link RouteDeps} — no globals.
 */

import type { Variant } from '@chess-platform/core';
import type { TiebreakKey } from '@chess-platform/tournament';
import type { RatingRow, TournamentsRepository } from '@chess-platform/persistence';
import { AuthService } from './auth/service';
import type { RequestMeta } from './auth/service';
import type { Repositories } from './deps';
import { Game, classifySpeed } from '@chess-platform/game';
import { parseRole, parseSeekColor, parseTimeControl, parseUuid, parseVariant, VARIANTS, HANDLE_PATTERN } from './domain';
import { HttpError } from './http/errors';
import { json, noContent } from './http/context';
import type { RequestContext } from './http/context';
import { Router } from './http/router';
import type { AuthPolicy } from './http/router';
import {
  buildRefreshCookie,
  clearRefreshCookie,
  parseCookies,
  REFRESH_COOKIE_NAME,
} from './http/cookie';
import { strictObject, oneOf, optInt, optString, parseLimit, reqString } from './http/validate';
import type { RateLimiter } from './ports/rate-limiter';
import type { Metrics } from './ports/metrics';
import type { ApiConfig } from './config';
import type { Clock } from './ports/clock';
import type { IdGenerator } from './ports/ids';
import { aggregatePlayer } from '@chess-platform/anti-cheat';
import {
  antiCheatAggregateView,
  antiCheatGameReportView,
  gameSummaryView,
  leaderboardEntry,
  publicUser,
  ratingView,
  seekView,
  selfUser,
  sessionView,
} from './presenters';
import { TournamentService } from './tournament/service';
import { ArenaService } from './tournament/arena.service';
import { summaryView, tournamentView, roundView, standingView, arenaTournamentView, arenaStandingView } from './tournament/presenters';
import { createLiveTournamentHandler } from './tournament/live';
import { buildOpenApiDocument } from './openapi/spec';
import type { OpenApiDocument, OpenApiInfo } from './openapi/spec';
import type { RouteDoc } from './openapi/types';
import type { GameLauncher } from './tournament/launcher';
import type { TournamentLiveView } from './tournament/live-view';

/** Collaborators the route handlers need. */
export interface RouteDeps {
  readonly auth: AuthService;
  readonly repos: Repositories;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly info: OpenApiInfo;
  readonly rateLimiter: RateLimiter;
  readonly config: ApiConfig;
  readonly tournamentRepo: TournamentsRepository;
  readonly gameLauncher: GameLauncher;
  readonly liveView: TournamentLiveView;
  readonly metrics: Metrics;
  readonly readiness: () => Promise<void>;
}

const PUBLIC: AuthPolicy = { required: false };
const AUTHED: AuthPolicy = { required: true };
const ADMIN: AuthPolicy = { required: true, anyRole: ['admin'] };
const MODERATION: AuthPolicy = { required: true, anyRole: ['moderator', 'admin'] };

const DEFAULT_LEADERBOARD_LIMIT = 50;
const MAX_LEADERBOARD_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** Build the fully-wired router. */
export function buildRouter(deps: RouteDeps): Router {
  const router = new Router();
  const { auth, repos, clock, ids, info, rateLimiter, config } = deps;

  const cookieOpts = { secure: config.cookieSecure };
  const refreshTokenTtlSec = config.refreshTokenTtlSec;

  let cachedSpec: OpenApiDocument | null = null;

  // --- Meta ----------------------------------------------------------------
  router.get(
    '/v1/health',
    doc({ summary: 'Liveness probe', tags: ['meta'], responses: { 200: ['Health', 'Service is up'] } }),
    PUBLIC,
    () => json(200, { status: 'ok', name: info.title, version: info.version }),
  );

  router.get(
    '/v1/ready',
    doc({
      summary: 'Readiness probe',
      tags: ['meta'],
      responses: { 200: ['Health', 'Dependencies are ready'], 503: ['Error', 'Dependency unavailable'] },
    }),
    PUBLIC,
    async () => {
      try {
        await deps.readiness();
      } catch {
        throw HttpError.unavailable('service dependencies are unavailable');
      }
      return json(200, { status: 'ok', name: info.title, version: info.version });
    },
  );

  router.get(
    '/v1/openapi.json',
    doc({
      summary: 'OpenAPI specification',
      tags: ['meta'],
      responses: { 200: [undefined, 'The OpenAPI 3.1 document'] },
    }),
    PUBLIC,
    () => {
      cachedSpec ??= buildOpenApiDocument(router, info);
      return json(200, cachedSpec);
    },
  );

  router.get(
    '/v1/metrics',
    doc({
      summary: 'Prometheus metrics exposition',
      tags: ['meta'],
      responses: { 200: [undefined, 'Prometheus text exposition (v0.0.4)'] },
    }),
    PUBLIC,
    () => ({
      status: 200,
      headers: { 'Content-Type': 'text/plain; version=0.0.4' },
      body: deps.metrics.render(),
    }),
  );

  // --- Auth ----------------------------------------------------------------
  router.post(
    '/v1/auth/register',
    doc({
      summary: 'Register a new account',
      tags: ['auth'],
      requestSchema: 'RegisterRequest',
      responses: { 201: ['AuthResponse', 'Account created'], 409: ['Error', 'Handle taken'] },
    }),
    PUBLIC,
    async (ctx) => {
      if (config.rateLimit.enabled) {
        const ipKey = `register:ip:${ctx.ip ?? 'unknown'}`;
        const ipCheck = await rateLimiter.check(ipKey, config.rateLimit.register.perIp);
        if (!ipCheck.allowed) {
          throw HttpError.rateLimited(ipCheck.retryAfterSeconds);
        }
      }

      const body = strictObject(ctx.body, ['handle', 'password', 'email']);
      const handle = reqString(body, 'handle', { trim: true, pattern: HANDLE_PATTERN });
      const password = reqString(body, 'password', { min: 8, max: 1024 });
      const email = optString(body, 'email', { max: 320, trim: true });
      const result = await auth.register({ handle, password, email: email ?? null }, meta(ctx));
      return json(201, {
        user: selfUser(result.user, result.roles),
        tokens: result.tokens,
      }, {
        'Set-Cookie': buildRefreshCookie(result.tokens.refreshToken, refreshTokenTtlSec, cookieOpts),
      });
    },
  );

  router.post(
    '/v1/auth/login',
    doc({
      summary: 'Log in with a password',
      tags: ['auth'],
      requestSchema: 'LoginRequest',
      responses: { 200: ['AuthResponse', 'Authenticated'], 401: ['Error', 'Invalid credentials'] },
    }),
    PUBLIC,
    async (ctx) => {
      const body = strictObject(ctx.body, ['handle', 'password']);
      const handle = reqString(body, 'handle', { trim: true });
      const password = reqString(body, 'password');

      if (config.rateLimit.enabled) {
        const ipKey = `login:ip:${ctx.ip ?? 'unknown'}`;
        const handleKey = `login:handle:${handle.toLowerCase()}`;
        
        const ipCheck = await rateLimiter.check(ipKey, config.rateLimit.login.perIp);
        if (!ipCheck.allowed) throw HttpError.rateLimited(ipCheck.retryAfterSeconds);

        const handleCheck = await rateLimiter.check(handleKey, config.rateLimit.login.perHandle);
        if (!handleCheck.allowed) throw HttpError.rateLimited(handleCheck.retryAfterSeconds);
      }

      const result = await auth.login({ handle, password }, meta(ctx));
      return json(200, {
        user: selfUser(result.user, result.roles),
        tokens: result.tokens,
      }, {
        'Set-Cookie': buildRefreshCookie(result.tokens.refreshToken, refreshTokenTtlSec, cookieOpts),
      });
    },
  );

  router.post(
    '/v1/auth/refresh',
    doc({
      summary: 'Rotate a refresh token',
      tags: ['auth'],
      requestSchema: 'RefreshRequest',
      responses: { 200: ['AuthResponse', 'New credentials'], 401: ['Error', 'Invalid/expired/reused'] },
    }),
    PUBLIC,
    async (ctx) => {
      if (config.rateLimit.enabled) {
        const ipKey = `refresh:ip:${ctx.ip ?? 'unknown'}`;
        const ipCheck = await rateLimiter.check(ipKey, config.rateLimit.refresh.perIp);
        if (!ipCheck.allowed) {
          throw HttpError.rateLimited(ipCheck.retryAfterSeconds);
        }
      }

      // Prefer the cookie; fall back to the JSON body for non-browser API clients.
      const refreshToken = resolveRefreshToken(ctx);
      if (!refreshToken) {
        throw HttpError.badRequest('refreshToken is required (cookie or body)');
      }
      const result = await auth.refresh(refreshToken, meta(ctx));
      return json(200, {
        user: selfUser(result.user, result.roles),
        tokens: result.tokens,
      }, {
        'Set-Cookie': buildRefreshCookie(result.tokens.refreshToken, refreshTokenTtlSec, cookieOpts),
      });
    },
  );

  router.post(
    '/v1/auth/logout',
    doc({
      summary: 'Revoke the presented refresh token',
      tags: ['auth'],
      security: 'bearer',
      requestSchema: 'RefreshRequest',
      responses: { 204: [undefined, 'Logged out'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      // Prefer the cookie; fall back to the JSON body for non-browser API clients.
      const refreshToken = resolveRefreshToken(ctx);
      if (!refreshToken) {
        throw HttpError.badRequest('refreshToken is required (cookie or body)');
      }
      await auth.logout(refreshToken, meta(ctx), identity.userId);
      return {
        status: 204,
        headers: { 'Set-Cookie': clearRefreshCookie(cookieOpts) },
      };
    },
  );

  router.get(
    '/v1/auth/sessions',
    doc({
      summary: "List the caller's sessions",
      tags: ['auth'],
      security: 'bearer',
      responses: { 200: ['SessionList', 'Sessions, most recent first'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const sessions = await auth.listSessions(identity.userId);
      return json(200, sessions.map(sessionView));
    },
  );

  router.post(
    '/v1/auth/password-reset/request',
    doc({
      summary: 'Request a password reset',
      tags: ['auth'],
      requestSchema: 'PasswordResetRequest',
      responses: { 202: [undefined, 'Accepted'] },
    }),
    PUBLIC,
    async (ctx) => {
      const body = strictObject(ctx.body, ['handleOrEmail']);
      const handleOrEmail = reqString(body, 'handleOrEmail', { trim: true });

      if (config.rateLimit.enabled) {
        const ipKey = `password-reset:ip:${ctx.ip ?? 'unknown'}`;
        const targetKey = `password-reset:target:${handleOrEmail.toLowerCase()}`;
        
        const ipCheck = await rateLimiter.check(ipKey, config.rateLimit.passwordResetRequest.perIp);
        if (!ipCheck.allowed) throw HttpError.rateLimited(ipCheck.retryAfterSeconds);

        const targetCheck = await rateLimiter.check(targetKey, config.rateLimit.passwordResetRequest.perTarget);
        if (!targetCheck.allowed) throw HttpError.rateLimited(targetCheck.retryAfterSeconds);
      }

      await auth.requestPasswordReset(handleOrEmail, meta(ctx));
      return { status: 202 };
    },
  );

  router.post(
    '/v1/auth/password-reset/confirm',
    doc({
      summary: 'Confirm a password reset',
      tags: ['auth'],
      requestSchema: 'PasswordResetConfirmRequest',
      responses: { 204: [undefined, 'Password reset'], 401: ['Error', 'Invalid or expired token'] },
    }),
    PUBLIC,
    async (ctx) => {
      const body = strictObject(ctx.body, ['token', 'newPassword']);
      const token = reqString(body, 'token');
      const newPassword = reqString(body, 'newPassword', { min: 8, max: 1024 });

      await auth.confirmPasswordReset(token, newPassword, meta(ctx));
      // Clear refresh cookie since sessions are revoked
      return {
        status: 204,
        headers: { 'Set-Cookie': clearRefreshCookie(cookieOpts) },
      };
    },
  );

  router.post(
    '/v1/auth/email/verify',
    doc({
      summary: 'Verify an email address',
      tags: ['auth'],
      requestSchema: 'EmailVerifyRequest',
      responses: { 204: [undefined, 'Email verified'], 401: ['Error', 'Invalid or expired token'] },
    }),
    PUBLIC,
    async (ctx) => {
      const body = strictObject(ctx.body, ['token']);
      const token = reqString(body, 'token');

      await auth.verifyEmail(token, meta(ctx));
      return noContent();
    },
  );

  // --- WebAuthn / Passkeys -------------------------------------------------
  router.get(
    '/v1/auth/webauthn/passkeys',
    doc({
      summary: 'List passkeys',
      tags: ['auth', 'webauthn'],
      security: 'bearer',
      responses: { 200: ['PasskeyList', 'Passkeys'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const list = await auth.listPasskeys(identity.userId);
      return json(200, list.map(c => ({
        id: c.id.toString('base64url'),
        name: c.name,
        createdAt: c.createdAt.toISOString(),
        lastUsedAt: c.lastUsedAt ? c.lastUsedAt.toISOString() : null,
      })));
    },
  );

  router.delete(
    '/v1/auth/webauthn/passkeys/:id',
    doc({
      summary: 'Delete a passkey',
      tags: ['auth', 'webauthn'],
      security: 'bearer',
      params: [pathParam('id', 'Base64URL encoded credential ID')],
      responses: { 204: [undefined, 'Deleted'], 404: ['Error', 'Not found'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      // convert base64url back to hex for internal use
      const idHex = Buffer.from(ctx.params['id']!, 'base64url').toString('hex');
      await auth.deletePasskey(identity.userId, idHex, meta(ctx));
      return noContent();
    },
  );

  router.post(
    '/v1/auth/webauthn/register/options',
    doc({
      summary: 'Get WebAuthn registration options',
      tags: ['auth', 'webauthn'],
      security: 'bearer',
      responses: { 200: ['WebAuthnRegisterOptions', 'Options'] },
    }),
    AUTHED,
    async (ctx) => {
      if (config.rateLimit.enabled) {
        const ipKey = `webauthn-register:ip:${ctx.ip ?? 'unknown'}`;
        const ipCheck = await rateLimiter.check(ipKey, config.rateLimit.webauthnRegister.perIp);
        if (!ipCheck.allowed) throw HttpError.rateLimited(ipCheck.retryAfterSeconds);
      }

      const identity = requireAuth(ctx);
      const options = await auth.generateWebAuthnRegisterOptions(identity.userId);
      return json(200, options);
    },
  );

  router.post(
    '/v1/auth/webauthn/register/verify',
    doc({
      summary: 'Verify WebAuthn registration',
      tags: ['auth', 'webauthn'],
      security: 'bearer',
      requestSchema: 'WebAuthnRegisterVerifyRequest',
      responses: { 200: ['PasskeyView', 'Registered'], 400: ['Error', 'Validation Error'] },
    }),
    AUTHED,
    async (ctx) => {
      if (config.rateLimit.enabled) {
        const ipKey = `webauthn-register:ip:${ctx.ip ?? 'unknown'}`;
        const ipCheck = await rateLimiter.check(ipKey, config.rateLimit.webauthnRegister.perIp);
        if (!ipCheck.allowed) throw HttpError.rateLimited(ipCheck.retryAfterSeconds);
      }

      const identity = requireAuth(ctx);
      const result = await auth.verifyWebAuthnRegister(identity.userId, ctx.body, meta(ctx));
      return json(200, result);
    },
  );

  router.post(
    '/v1/auth/webauthn/login/options',
    doc({
      summary: 'Get WebAuthn login options',
      tags: ['auth', 'webauthn'],
      requestSchema: 'WebAuthnLoginOptionsRequest',
      responses: { 200: ['WebAuthnLoginOptions', 'Options'] },
    }),
    PUBLIC,
    async (ctx) => {
      const body = strictObject(ctx.body, ['handle']);
      const handle = reqString(body, 'handle', { trim: true });

      if (config.rateLimit.enabled) {
        const ipKey = `webauthn-login:ip:${ctx.ip ?? 'unknown'}`;
        const handleKey = `webauthn-login:handle:${handle.toLowerCase()}`;

        const ipCheck = await rateLimiter.check(ipKey, config.rateLimit.webauthnLogin.perIp);
        if (!ipCheck.allowed) throw HttpError.rateLimited(ipCheck.retryAfterSeconds);

        const handleCheck = await rateLimiter.check(handleKey, config.rateLimit.webauthnLogin.perHandle);
        if (!handleCheck.allowed) throw HttpError.rateLimited(handleCheck.retryAfterSeconds);
      }

      const options = await auth.generateWebAuthnLoginOptions(handle);
      return json(200, options);
    },
  );

  router.post(
    '/v1/auth/webauthn/login/verify',
    doc({
      summary: 'Verify WebAuthn login',
      tags: ['auth', 'webauthn'],
      requestSchema: 'WebAuthnLoginVerifyRequest',
      responses: { 200: ['AuthResponse', 'Authenticated'], 401: ['Error', 'Invalid credentials'] },
    }),
    PUBLIC,
    async (ctx) => {
      if (config.rateLimit.enabled) {
        const ipKey = `webauthn-login:ip:${ctx.ip ?? 'unknown'}`;
        const ipCheck = await rateLimiter.check(ipKey, config.rateLimit.webauthnLogin.perIp);
        if (!ipCheck.allowed) throw HttpError.rateLimited(ipCheck.retryAfterSeconds);
      }

      const result = await auth.verifyWebAuthnLogin(ctx.body, meta(ctx));
      return json(200, {
        user: selfUser(result.user, result.roles),
        tokens: result.tokens,
      }, {
        'Set-Cookie': buildRefreshCookie(result.tokens.refreshToken, refreshTokenTtlSec, cookieOpts),
      });
    },
  );

  // --- Users ---------------------------------------------------------------
  router.get(
    '/v1/users/me',
    doc({
      summary: 'Get the authenticated account',
      tags: ['users'],
      security: 'bearer',
      responses: { 200: ['SelfUser', 'The caller'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const user = await repos.users.findById(identity.userId);
      if (!user) throw HttpError.notFound('account not found');
      const roles = await repos.users.rolesOf(user.id);
      return json(200, selfUser(user, roles));
    },
  );

  router.get(
    '/v1/users/:handle',
    doc({
      summary: 'Get a public profile with ratings',
      tags: ['users'],
      params: [pathParam('handle', 'User handle')],
      responses: { 200: ['UserProfile', 'Profile'], 404: ['Error', 'No such user'] },
    }),
    PUBLIC,
    async (ctx) => {
      const user = await findUserByHandle(repos, ctx.params['handle']!);
      const ratings = await allRatings(repos, user.id);
      return json(200, { user: publicUser(user), ratings: ratings.map(ratingView) });
    },
  );

  router.get(
    '/v1/users/:handle/ratings',
    doc({
      summary: "Get a user's ratings across variants",
      tags: ['users', 'ratings'],
      params: [pathParam('handle', 'User handle')],
      responses: { 200: ['RatingList', 'Ratings'], 404: ['Error', 'No such user'] },
    }),
    PUBLIC,
    async (ctx) => {
      const user = await findUserByHandle(repos, ctx.params['handle']!);
      const ratings = await allRatings(repos, user.id);
      return json(200, ratings.map(ratingView));
    },
  );

  router.get(
    '/v1/users/:handle/games',
    doc({
      summary: "Get a user's recent games",
      tags: ['users', 'games'],
      params: [pathParam('handle', 'User handle'), limitParam()],
      responses: { 200: ['GameList', 'Recent games'], 404: ['Error', 'No such user'] },
    }),
    PUBLIC,
    async (ctx) => {
      const user = await findUserByHandle(repos, ctx.params['handle']!);
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const games = await repos.games.recentForUser(user.id, limit);
      return json(200, games.map(gameSummaryView));
    },
  );

  router.post(
    '/v1/users/:userId/roles',
    doc({
      summary: 'Grant a role to a user (admin only)',
      tags: ['users', 'admin'],
      security: 'bearer',
      params: [pathParam('userId', 'Target user id')],
      requestSchema: 'GrantRoleRequest',
      responses: { 204: [undefined, 'Role granted'], 404: ['Error', 'No such user'] },
    }),
    ADMIN,
    async (ctx) => {
      const actor = requireAuth(ctx);
      const body = strictObject(ctx.body, ['role']);
      const role = parseRole(reqString(body, 'role'));
      const targetId = ctx.params['userId']!;
      const target = await repos.users.findById(targetId);
      if (!target) throw HttpError.notFound('user not found');
      await repos.users.addRole(targetId, role);
      await repos.audit.record({
        actorId: actor.userId,
        action: 'roles.grant',
        target: targetId,
        meta: { role },
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        at: clock.now(),
      });
      return noContent();
    },
  );

  // --- Moderation / Anti-Cheat ---------------------------------------------
  router.get(
    '/v1/moderation/anti-cheat/players/:playerId',
    doc({
      summary: 'View anti-cheat aggregate report for a player',
      security: 'bearer',
      params: [pathParam('playerId', 'Target player ID (UUID)')],
      tags: ['moderation', 'anti-cheat'],
      responses: {
        200: ['AntiCheatAggregateView', 'Aggregated report'],
        422: ['Error', 'Malformed player ID'],
      },
    }),
    MODERATION,
    async (ctx) => {
      const actor = requireAuth(ctx);
      const playerId = parseUuid(ctx.params['playerId']!, 'playerId');
      // Audit the access attempt before reading report data, so a moderator
      // can never see a report without a guaranteed audit row for it (ADR-0033).
      await repos.audit.record({
        actorId: actor.userId,
        action: 'anti_cheat.aggregate.view',
        target: playerId,
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        at: clock.now(),
      });
      const stored = await repos.antiCheat.listByPlayer(playerId);
      const report = aggregatePlayer(stored.map((r) => ({ gameId: r.gameId, report: r.report })));
      return json(200, antiCheatAggregateView(playerId, report));
    },
  );

  router.get(
    '/v1/moderation/anti-cheat/players/:playerId/games',
    doc({
      summary: 'List per-game anti-cheat reports for a player',
      security: 'bearer',
      params: [pathParam('playerId', 'Target player ID (UUID)'), limitParam()],
      tags: ['moderation', 'anti-cheat'],
      responses: {
        200: ['AntiCheatGameReportList', 'List of per-game reports'],
        422: ['Error', 'Malformed player ID'],
      },
    }),
    MODERATION,
    async (ctx) => {
      const actor = requireAuth(ctx);
      const playerId = parseUuid(ctx.params['playerId']!, 'playerId');
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      // Audit the access attempt before reading report data, so a moderator
      // can never see a report without a guaranteed audit row for it (ADR-0033).
      await repos.audit.record({
        actorId: actor.userId,
        action: 'anti_cheat.games.view',
        target: playerId,
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        at: clock.now(),
      });
      const stored = await repos.antiCheat.listByPlayer(playerId);
      return json(200, stored.slice(0, limit).map(antiCheatGameReportView));
    },
  );

  // --- Ratings / leaderboard ----------------------------------------------
  router.get(
    '/v1/leaderboard/:variant',
    doc({
      summary: 'Top players for a variant',
      tags: ['ratings'],
      params: [pathParam('variant', 'Variant code'), limitParam()],
      responses: { 200: ['LeaderboardList', 'Leaderboard'], 422: ['Error', 'Bad variant'] },
    }),
    PUBLIC,
    async (ctx) => {
      const variant = parseVariant(ctx.params['variant']!);
      const limit = parseLimit(ctx.query, DEFAULT_LEADERBOARD_LIMIT, MAX_LEADERBOARD_LIMIT);
      const rows = await repos.ratings.leaderboard(variant, limit);
      return json(200, rows.map(leaderboardEntry));
    },
  );

  // --- Seeks / lobby -------------------------------------------------------
  router.get(
    '/v1/seeks',
    doc({
      summary: 'List open seeks',
      tags: ['seeks'],
      params: [limitParam()],
      responses: { 200: ['SeekList', 'Open seeks'] },
    }),
    PUBLIC,
    async (ctx) => {
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      
      if (Math.random() < 0.1) {
        repos.seeks.cleanup(new Date(clock.now())).catch(() => {});
      }

      const seeks = await repos.seeks.listOpen(limit, ctx.auth?.userId);
      return json(200, seeks.map(seekView));
    },
  );

  router.post(
    '/v1/seeks',
    doc({
      summary: 'Create a seek',
      tags: ['seeks'],
      security: 'bearer',
      requestSchema: 'CreateSeekRequest',
      responses: { 201: ['SeekView', 'Seek created'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const body = strictObject(ctx.body, ['variant', 'timeControl', 'rated', 'color', 'minRating', 'maxRating']);
      const variant = parseVariant(oneOf(reqString(body, 'variant'), VARIANTS, 'variant'));
      const timeControl = parseTimeControl(body['timeControl']);
      const rated = body['rated'] === undefined ? true : body['rated'] === true;
      const color = body['color'] === undefined ? 'random' : parseSeekColor(reqString(body, 'color'));
      const minRating = optInt(body, 'minRating', { min: 0, max: 4000 });
      const maxRating = optInt(body, 'maxRating', { min: 0, max: 4000 });
      if (minRating !== undefined && maxRating !== undefined && minRating > maxRating) {
        throw HttpError.validation('minRating cannot exceed maxRating', {
          minRating: 'must be <= maxRating',
        });
      }
      const seek = await repos.seeks.create({
        id: ids.next(),
        creatorId: identity.userId,
        variant,
        timeControl,
        rated,
        color,
        minRating: minRating ?? null,
        maxRating: maxRating ?? null,
      });
      return json(201, seekView(seek));
    },
  );

  router.delete(
    '/v1/seeks/:id',
    doc({
      summary: 'Cancel a seek (owner or moderator)',
      tags: ['seeks'],
      security: 'bearer',
      params: [pathParam('id', 'Seek id')],
      responses: { 204: [undefined, 'Cancelled'], 403: ['Error', 'Not owner'], 404: ['Error', 'No such seek'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const seek = await repos.seeks.findById(ctx.params['id']!);
      if (!seek) throw HttpError.notFound('seek not found');
      const privileged = identity.roles.includes('moderator') || identity.roles.includes('admin');
      if (seek.creatorId !== identity.userId && !privileged) {
        throw HttpError.forbidden('only the creator or a moderator can cancel this seek');
      }
      const removed = await repos.seeks.remove(seek.id);
      if (!removed) throw HttpError.notFound('seek not found or already accepted');
      return noContent();
    },
  );

  router.post(
    '/v1/seeks/:id/accept',
    doc({
      summary: 'Accept an open seek',
      tags: ['seeks'],
      security: 'bearer',
      params: [pathParam('id', 'Seek id')],
      responses: { 
        200: ['SeekView', 'Seek matched and game created'],
        400: ['Error', 'Cannot accept own seek'],
        403: ['Error', 'Rating requirements not met'],
        404: ['Error', 'Seek not found or already accepted'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const seek = await repos.seeks.findById(ctx.params['id']!);
      if (!seek || seek.gameId !== null) throw HttpError.notFound('seek not found or already accepted');
      if (seek.creatorId === identity.userId) throw HttpError.badRequest('cannot accept own seek');

      if (seek.minRating !== null || seek.maxRating !== null) {
        const ratingRow = await repos.ratings.get(identity.userId, seek.variant);
        const currentRating = ratingRow ? ratingRow.rating : 1500;
        if (seek.minRating !== null && currentRating < seek.minRating) {
          throw HttpError.forbidden('rating too low for this seek');
        }
        if (seek.maxRating !== null && currentRating > seek.maxRating) {
          throw HttpError.forbidden('rating too high for this seek');
        }
      }

      let whiteId: string;
      let blackId: string;
      if (seek.color === 'white') {
        whiteId = seek.creatorId;
        blackId = identity.userId;
      } else if (seek.color === 'black') {
        whiteId = identity.userId;
        blackId = seek.creatorId;
      } else {
        if (Math.random() < 0.5) {
          whiteId = seek.creatorId;
          blackId = identity.userId;
        } else {
          whiteId = identity.userId;
          blackId = seek.creatorId;
        }
      }

      const gameId = ids.next();
      const startedAt = clock.now();
      const { events } = Game.create({
        gameId,
        variant: seek.variant,
        timeControl: seek.timeControl,
        players: { white: whiteId, black: blackId },
        rated: seek.rated,
        at: startedAt,
      });

      const updatedSeek = await repos.seekAcceptor.accept(seek.id, gameId, events, {
        id: gameId,
        variant: seek.variant,
        rated: seek.rated,
        speed: classifySpeed(seek.timeControl),
        whiteId,
        blackId,
        startedAt: new Date(startedAt),
      });

      if (!updatedSeek) throw HttpError.notFound('seek not found or already accepted');
      return json(200, seekView(updatedSeek));
    },
  );

  // --- Games ---------------------------------------------------------------
  router.get(
    '/v1/games/:id',
    doc({
      summary: 'Get a game summary',
      tags: ['games'],
      params: [pathParam('id', 'Game id')],
      responses: { 200: ['GameSummary', 'Game'], 404: ['Error', 'No such game'] },
    }),
    PUBLIC,
    async (ctx) => {
      const game = await repos.games.findById(ctx.params['id']!);
      if (!game) throw HttpError.notFound('game not found');
      return json(200, gameSummaryView(game));
    },
  );

  // --- Tournaments ---------------------------------------------------------
  const tournamentService = new TournamentService(deps.tournamentRepo, deps.gameLauncher);
  const arenaService = new ArenaService(deps.tournamentRepo, deps.gameLauncher, () => deps.clock.now());

  router.post(
    '/v1/tournaments',
    doc({
      summary: 'Create a tournament',
      tags: ['tournaments'],
      security: 'bearer',
      requestSchema: 'CreateTournamentRequest',
      responses: { 201: ['TournamentAnyView', 'Tournament created'], 403: ['Error', 'Forbidden'], 422: ['Error', 'Validation error'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      if (!identity.roles.includes('tournament_director')) {
        throw HttpError.forbidden('only tournament directors can create tournaments');
      }
      const body = strictObject(ctx.body, ['name', 'format', 'variant', 'timeControl', 'rounds', 'durationMs', 'tiebreakOrder']);
      const format = oneOf(reqString(body, 'format'), ['round_robin', 'swiss', 'arena'], 'format');
      const variantRaw = oneOf(reqString(body, 'variant'), VARIANTS, 'variant');
      const variant = parseVariant(variantRaw) as 'standard' | 'chess960';
      const timeControl = parseTimeControl(body['timeControl']);

      if (format === 'arena') {
        const durationMs = optInt(body, 'durationMs');
        if (!durationMs) throw HttpError.validation('durationMs is required for arena format');
        const t = await arenaService.create({
          id: ids.next(),
          name: reqString(body, 'name', { trim: true }),
          variant,
          timeControl,
          durationMs,
        });
        return json(201, arenaTournamentView(t));
      } else {
        const rounds = format === 'swiss' ? optInt(body, 'rounds') : undefined;
        const rawTiebreak = body['tiebreakOrder'];
        let tiebreakOrder: readonly TiebreakKey[] | undefined;
        if (rawTiebreak !== undefined) {
          if (!Array.isArray(rawTiebreak)) {
            throw HttpError.validation('tiebreakOrder must be an array', { tiebreakOrder: rawTiebreak });
          }
          tiebreakOrder = rawTiebreak.map((k) =>
            oneOf(String(k), ['sonneborn_berger', 'buchholz', 'median_buchholz'], 'tiebreakOrder'),
          );
        }
        const t = await tournamentService.create({
          id: ids.next(),
          name: reqString(body, 'name', { trim: true }),
          format: format as 'round_robin' | 'swiss',
          variant,
          timeControl,
          rounds,
          tiebreakOrder,
        });
        return json(201, tournamentView(t));
      }
    },
  );

  router.get(
    '/v1/tournaments',
    doc({
      summary: 'List tournaments',
      tags: ['tournaments'],
      params: [limitParam()],
      responses: { 200: ['TournamentSummaryList', 'Tournaments'] },
    }),
    PUBLIC,
    async (ctx) => {
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const list = await deps.tournamentRepo.list(limit);
      return json(200, list.map(summaryView));
    },
  );

  router.get(
    '/v1/tournaments/:id',
    doc({
      summary: 'Get tournament details',
      tags: ['tournaments'],
      params: [pathParam('id', 'Tournament id')],
      responses: { 200: ['TournamentAnyView', 'Tournament'], 404: ['Error', 'Not found'] },
    }),
    PUBLIC,
    async (ctx) => {
      const stored = await deps.tournamentRepo.findById(ctx.params['id']!);
      const snap = stored?.snapshot;
      if (!snap) throw HttpError.notFound('tournament not found');
      if (snap.config.format === 'arena') {
        const t = await arenaService.getTournament(ctx.params['id']!);
        return json(200, arenaTournamentView(t));
      }
      const t = await tournamentService.load(ctx.params['id']!);
      return json(200, tournamentView(t));
    },
  );

  router.post(
    '/v1/tournaments/:id/participants',
    doc({
      summary: 'Register for a tournament',
      tags: ['tournaments'],
      security: 'bearer',
      params: [pathParam('id', 'Tournament id')],
      requestSchema: 'RegisterParticipantRequest',
      responses: { 200: ['TournamentAnyView', 'Registered'], 403: ['Error', 'Forbidden'], 404: ['Error', 'Not found'], 409: ['Error', 'Conflict'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const isDirector = identity.roles.includes('tournament_director');
      let targetId = identity.userId;

      if (ctx.body && typeof ctx.body === 'object' && 'playerId' in ctx.body) {
        if (!isDirector) {
          throw HttpError.forbidden('only tournament directors can register other players');
        }
        targetId = reqString(ctx.body as Record<string, unknown>, 'playerId');
      }

      const stored = await deps.tournamentRepo.findById(ctx.params['id']!);
      const snap = stored?.snapshot;
      if (!snap) throw HttpError.notFound('tournament not found');
      if (snap.config.format === 'arena') {
        const t = await arenaService.register(ctx.params['id']!, targetId);
        return json(200, arenaTournamentView(t));
      }
      const t = await tournamentService.register(ctx.params['id']!, targetId);
      return json(200, tournamentView(t));
    },
  );

  router.delete(
    '/v1/tournaments/:id/participants/:playerId',
    doc({
      summary: 'Withdraw from a tournament',
      tags: ['tournaments'],
      security: 'bearer',
      params: [pathParam('id', 'Tournament id'), pathParam('playerId', 'Target user id')],
      responses: { 200: ['TournamentAnyView', 'Withdrawn'], 403: ['Error', 'Forbidden'], 404: ['Error', 'Not found'], 409: ['Error', 'Conflict'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const targetId = ctx.params['playerId']!;
      const isSelf = targetId === identity.userId;
      const isDirector = identity.roles.includes('tournament_director');

      if (!isSelf && !isDirector) {
        throw HttpError.forbidden('cannot withdraw other players unless you are a director');
      }

      const stored = await deps.tournamentRepo.findById(ctx.params['id']!);
      const snap = stored?.snapshot;
      if (!snap) throw HttpError.notFound('tournament not found');
      if (snap.config.format === 'arena') {
        const t = await arenaService.withdraw(ctx.params['id']!, targetId);
        return json(200, arenaTournamentView(t));
      }
      const t = await tournamentService.withdraw(ctx.params['id']!, targetId);
      return json(200, tournamentView(t));
    },
  );

  router.post(
    '/v1/tournaments/:id/start',
    doc({
      summary: 'Start a tournament',
      tags: ['tournaments'],
      security: 'bearer',
      params: [pathParam('id', 'Tournament id')],
      responses: { 200: ['TournamentAnyView', 'Started'], 403: ['Error', 'Forbidden'], 404: ['Error', 'Not found'], 409: ['Error', 'Conflict'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      if (!identity.roles.includes('tournament_director')) {
        throw HttpError.forbidden('only tournament directors can start tournaments');
      }
      const stored = await deps.tournamentRepo.findById(ctx.params['id']!);
      const snap = stored?.snapshot;
      if (!snap) throw HttpError.notFound('tournament not found');
      if (snap.config.format === 'arena') {
        const t = await arenaService.start(ctx.params['id']!, deps.clock.now());
        return json(200, arenaTournamentView(t));
      }
      const t = await tournamentService.start(ctx.params['id']!);
      return json(200, tournamentView(t));
    },
  );

  router.get(
    '/v1/tournaments/:id/rounds',
    doc({
      summary: 'List generated rounds',
      tags: ['tournaments'],
      params: [pathParam('id', 'Tournament id')],
      responses: { 200: ['RoundList', 'Rounds'], 404: ['Error', 'Not found'] },
    }),
    PUBLIC,
    async (ctx) => {
      const t = await tournamentService.load(ctx.params['id']!);
      return json(200, t.getRounds().map(round => roundView(round, t)));
    },
  );

  router.post(
    '/v1/tournaments/:id/rounds/:roundIndex/results',
    doc({
      summary: 'Record a game result',
      tags: ['tournaments'],
      security: 'bearer',
      params: [pathParam('id', 'Tournament id'), pathParam('roundIndex', 'Round index')],
      requestSchema: 'RecordResultRequest',
      responses: { 200: ['TournamentAnyView', 'Result recorded'], 403: ['Error', 'Forbidden'], 404: ['Error', 'Not found'], 409: ['Error', 'Conflict'], 422: ['Error', 'Validation error'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      if (!identity.roles.includes('tournament_director')) {
        throw HttpError.forbidden('only tournament directors can record results');
      }
      const roundIndex = parseInt(ctx.params['roundIndex']!, 10);
      if (isNaN(roundIndex)) throw HttpError.validation('Invalid roundIndex', { roundIndex: 'must be an integer' });

      const body = strictObject(ctx.body, ['pairingIndex', 'result']);
      const pairingIndex = optInt(body, 'pairingIndex');
      if (pairingIndex === undefined) throw HttpError.validation('pairingIndex is required', {});
      const result = oneOf(reqString(body, 'result'), ['white_win', 'black_win', 'draw'], 'result');

      const t = await tournamentService.recordResult(ctx.params['id']!, {
        roundIndex,
        pairingIndex,
        result: result as 'white_win' | 'black_win' | 'draw',
      });
      return json(200, tournamentView(t));
    },
  );

  router.post(
    '/v1/tournaments/:id/games/:gameId/result',
    doc({
      summary: 'Record a game result by game id',
      tags: ['tournaments'],
      security: 'bearer',
      params: [pathParam('id', 'Tournament id'), pathParam('gameId', 'Game id')],
      requestSchema: 'RecordResultByGameRequest',
      responses: { 200: ['TournamentAnyView', 'Result recorded'], 403: ['Error', 'Forbidden'], 404: ['Error', 'Not found'], 409: ['Error', 'Conflict'], 422: ['Error', 'Validation error'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      if (!identity.roles.includes('tournament_director')) {
        throw HttpError.forbidden('only tournament directors can record results');
      }

      const body = strictObject(ctx.body, ['result']);
      const result = oneOf(reqString(body, 'result'), ['white_win', 'black_win', 'draw'], 'result');

      const stored = await deps.tournamentRepo.findById(ctx.params['id']!);
      const snap = stored?.snapshot;
      if (!snap) throw HttpError.notFound('tournament not found');
      if (snap.config.format === 'arena') {
        const t = await arenaService.recordResultByGame(
          ctx.params['id']!,
          ctx.params['gameId']!,
          result as 'white_win' | 'black_win' | 'draw'
        );
        return json(200, arenaTournamentView(t));
      }
      const t = await tournamentService.recordResultByGame(
        ctx.params['id']!,
        ctx.params['gameId']!,
        result as 'white_win' | 'black_win' | 'draw'
      );
      return json(200, tournamentView(t));
    },
  );

  router.get(
    '/v1/tournaments/:id/standings',
    doc({
      summary: 'Get tournament standings',
      tags: ['tournaments'],
      params: [pathParam('id', 'Tournament id')],
      responses: { 200: ['StandingAnyList', 'Standings'], 404: ['Error', 'Not found'] },
    }),
    PUBLIC,
    async (ctx) => {
      const stored = await deps.tournamentRepo.findById(ctx.params['id']!);
      const snap = stored?.snapshot;
      if (!snap) throw HttpError.notFound('tournament not found');
      if (snap.config.format === 'arena') {
        const standings = await arenaService.getStandings(ctx.params['id']!);
        return json(200, standings.map((s, i) => arenaStandingView(s, i)));
      }
      const t = await tournamentService.load(ctx.params['id']!);
      return json(200, t.standings().map(standingView));
    },
  );

  router.get(
    '/v1/tournaments/:id/live',
    doc({
      summary: 'Get live active games and standings',
      tags: ['tournaments'],
      params: [pathParam('id', 'Tournament id')],
      responses: { 200: ['TournamentLiveResponse', 'Live tournament data'], 404: ['Error', 'Not found'] },
    }),
    PUBLIC,
    createLiveTournamentHandler(deps),
  );

  return router;
}

// --- helpers ---------------------------------------------------------------

/**
 * Resolve the refresh token from the request, preferring the httpOnly cookie
 * over the JSON body. This keeps browser clients (cookie) and non-browser API
 * clients (body) both working.
 */
function resolveRefreshToken(ctx: RequestContext): string | undefined {
  const cookies = parseCookies(headerString(ctx.headers['cookie']));
  const fromCookie = cookies[REFRESH_COOKIE_NAME];
  if (fromCookie) return fromCookie;
  // Fall back to the JSON body for non-browser API clients.
  if (ctx.body !== undefined && typeof ctx.body === 'object') {
    const body = ctx.body as Record<string, unknown>;
    const raw = body['refreshToken'];
    if (typeof raw === 'string') return raw;
  }
  return undefined;
}

/** Safely extract a single string from a header that may be a string or array. */
function headerString(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function meta(ctx: RequestContext): RequestMeta {
  const traceId = ctx.headers['x-trace-id'];
  return {
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
    traceId: typeof traceId === 'string' ? traceId : null,
  };
}

function requireAuth(ctx: RequestContext): NonNullable<RequestContext['auth']> {
  if (!ctx.auth) throw HttpError.unauthorized();
  return ctx.auth;
}

async function findUserByHandle(repos: Repositories, handle: string) {
  const user = await repos.users.findByHandle(handle);
  if (!user) throw HttpError.notFound('user not found');
  return user;
}

async function allRatings(repos: Repositories, userId: string): Promise<RatingRow[]> {
  const rows = await Promise.all(VARIANTS.map((v: Variant) => repos.ratings.get(userId, v)));
  return rows.filter((r): r is RatingRow => r !== null);
}

interface DocSpec {
  summary: string;
  tags: string[];
  description?: string;
  security?: 'bearer';
  requestSchema?: string;
  params?: RouteDoc['params'];
  responses: Record<number, [string | undefined, string]>;
}

function doc(spec: DocSpec): RouteDoc {
  const responses: Record<number, { description: string; schema?: string }> = {};
  for (const [status, [schema, description]] of Object.entries(spec.responses)) {
    responses[Number(status)] = schema ? { description, schema } : { description };
  }
  return {
    summary: spec.summary,
    tags: spec.tags,
    security: spec.security ?? 'none',
    ...(spec.description ? { description: spec.description } : {}),
    ...(spec.requestSchema ? { requestSchema: spec.requestSchema } : {}),
    ...(spec.params ? { params: spec.params } : {}),
    responses,
  };
}

function pathParam(name: string, description: string): NonNullable<RouteDoc['params']>[number] {
  return { name, in: 'path', required: true, description, schema: { type: 'string' } };
}

function limitParam(): NonNullable<RouteDoc['params']>[number] {
  return {
    name: 'limit',
    in: 'query',
    required: false,
    description: 'Maximum number of results.',
    schema: { type: 'integer', minimum: 1 },
  };
}
