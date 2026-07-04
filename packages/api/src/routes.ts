/**
 * @packageDocumentation
 * The route table. Each route couples its OpenAPI contract, its auth policy, and
 * its handler, so the served behavior and the published spec come from one
 * definition. Handlers stay thin: validate input, call a service/repository,
 * present the result. All collaborators arrive via {@link RouteDeps} — no globals.
 */

import type { Variant } from '@chess-platform/core';
import type { RatingRow } from '@chess-platform/persistence';
import { AuthService } from './auth/service';
import type { RequestMeta } from './auth/service';
import type { Repositories } from './deps';
import { parseRole, parseTimeControl, parseVariant, VARIANTS, HANDLE_PATTERN } from './domain';
import { HttpError } from './http/errors';
import { json, noContent } from './http/context';
import type { RequestContext } from './http/context';
import { Router } from './http/router';
import type { AuthPolicy } from './http/router';
import { asObject, oneOf, optInt, optString, parseLimit, reqString } from './http/validate';
import type { Clock } from './ports/clock';
import type { IdGenerator } from './ports/ids';
import {
  gameSummaryView,
  leaderboardEntry,
  publicUser,
  ratingView,
  seekView,
  selfUser,
  sessionView,
} from './presenters';
import { buildOpenApiDocument } from './openapi/spec';
import type { OpenApiDocument, OpenApiInfo } from './openapi/spec';
import type { RouteDoc } from './openapi/types';

/** Collaborators the route handlers need. */
export interface RouteDeps {
  readonly auth: AuthService;
  readonly repos: Repositories;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly info: OpenApiInfo;
}

const PUBLIC: AuthPolicy = { required: false };
const AUTHED: AuthPolicy = { required: true };
const ADMIN: AuthPolicy = { required: true, anyRole: ['admin'] };

const DEFAULT_LEADERBOARD_LIMIT = 50;
const MAX_LEADERBOARD_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** Build the fully-wired router. */
export function buildRouter(deps: RouteDeps): Router {
  const router = new Router();
  const { auth, repos, clock, ids, info } = deps;

  let cachedSpec: OpenApiDocument | null = null;

  // --- Meta ----------------------------------------------------------------
  router.get(
    '/v1/health',
    doc({ summary: 'Liveness probe', tags: ['meta'], responses: { 200: ['Health', 'Service is up'] } }),
    PUBLIC,
    () => json(200, { status: 'ok', name: info.title, version: info.version }),
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
      const body = asObject(ctx.body);
      const handle = reqString(body, 'handle', { trim: true, pattern: HANDLE_PATTERN });
      const password = reqString(body, 'password', { min: 8, max: 1024 });
      const email = optString(body, 'email', { max: 320, trim: true });
      const result = await auth.register({ handle, password, email: email ?? null }, meta(ctx));
      return json(201, { user: selfUser(result.user, result.roles), tokens: result.tokens });
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
      const body = asObject(ctx.body);
      const handle = reqString(body, 'handle', { trim: true });
      const password = reqString(body, 'password');
      const result = await auth.login({ handle, password }, meta(ctx));
      return json(200, { user: selfUser(result.user, result.roles), tokens: result.tokens });
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
      const body = asObject(ctx.body);
      const refreshToken = reqString(body, 'refreshToken');
      const result = await auth.refresh(refreshToken, meta(ctx));
      return json(200, { user: selfUser(result.user, result.roles), tokens: result.tokens });
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
      const body = asObject(ctx.body);
      const refreshToken = reqString(body, 'refreshToken');
      await auth.logout(refreshToken, meta(ctx), identity.userId);
      return noContent();
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
      const body = asObject(ctx.body);
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
      const seeks = await repos.seeks.listOpen(limit);
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
      const body = asObject(ctx.body);
      const variant = parseVariant(oneOf(reqString(body, 'variant'), VARIANTS, 'variant'));
      const timeControl = parseTimeControl(body['timeControl']);
      const rated = body['rated'] === undefined ? true : body['rated'] === true;
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
      await repos.seeks.remove(seek.id);
      return noContent();
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

  return router;
}

// --- helpers ---------------------------------------------------------------

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
