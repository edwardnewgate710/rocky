/**
 * @packageDocumentation
 * The identity service: registration, login, stateless access tokens, and
 * rotating opaque refresh tokens with theft detection.
 *
 * Security properties enforced here:
 * - Passwords are only ever stored via the {@link PasswordHasher} (scrypt by
 *   default); plaintext never persists and never appears in logs or audit meta.
 * - Login does a hash comparison even when the handle is unknown, so response
 *   timing does not reveal whether an account exists.
 * - Refresh tokens are single-use. Each refresh rotates to a fresh token and
 *   revokes the presenting session (`rotated_from` links the chain). Presenting
 *   an already-revoked (i.e. previously rotated) token is treated as theft: the
 *   entire session chain for that user is revoked and the attempt is audited.
 */

import { createHash } from 'node:crypto';
import type { Role, SessionRow, UserRow } from '@chess-platform/persistence';
import { HttpError } from '../http/errors';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/ids';
import type { Repositories } from '../deps';
import { generateRefreshToken, hashRefreshToken } from './refresh';
import type { AccessTokenService } from './tokens';
import type { PasswordHasher } from './password';

/** Per-request metadata attached to sessions and audit records. */
export interface RequestMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string;
  readonly traceId?: string | null;
}

/** The credential set returned to a client after auth. */
export interface TokenPair {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  /** Access-token lifetime in seconds. */
  readonly expiresIn: number;
  readonly refreshToken: string;
  /** Refresh-token absolute expiry (ISO 8601). */
  readonly refreshExpiresAt: string;
}

/** An authenticated principal with its granted roles. */
export interface AuthenticatedUser {
  readonly user: UserRow;
  readonly roles: readonly Role[];
}

/** Result of a successful auth flow. */
export interface AuthResult extends AuthenticatedUser {
  readonly tokens: TokenPair;
}

// A fixed decoy hash so an unknown handle still incurs a verify cost (anti-enumeration).
const DECOY_HASH =
  'scrypt$N=16384,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export class AuthService {
  private readonly repos: Repositories;
  private readonly hasher: PasswordHasher;
  private readonly tokens: AccessTokenService;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly refreshTtlSec: number;

  constructor(deps: {
    repos: Repositories;
    hasher: PasswordHasher;
    tokens: AccessTokenService;
    clock: Clock;
    ids: IdGenerator;
    refreshTtlSec: number;
  }) {
    this.repos = deps.repos;
    this.hasher = deps.hasher;
    this.tokens = deps.tokens;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.refreshTtlSec = deps.refreshTtlSec;
  }

  /** Create an account, grant the base `user` role, and start a session. */
  async register(
    input: { handle: string; password: string; email?: string | null },
    meta: RequestMeta,
  ): Promise<AuthResult> {
    const existing = await this.repos.users.findByHandle(input.handle);
    if (existing) {
      throw HttpError.conflict('handle is already taken', { handle: 'taken' });
    }
    const secretHash = await this.hasher.hash(input.password);
    const user = await this.repos.users.create({
      id: this.ids.next(),
      handle: input.handle,
      emailHash: input.email ? emailHash(input.email) : null,
    });
    await this.repos.users.setPassword(user.id, secretHash);
    await this.repos.users.addRole(user.id, 'user');
    const roles = await this.repos.users.rolesOf(user.id);

    const tokens = await this.startSession(user, roles, meta);
    await this.audit(meta, user.id, 'auth.register', user.id);
    return { user, roles, tokens };
  }

  /** Verify credentials and start a session. */
  async login(
    input: { handle: string; password: string },
    meta: RequestMeta,
  ): Promise<AuthResult> {
    const user = await this.repos.users.findByHandle(input.handle);
    if (!user) {
      // Spend comparable time to a real verify so timing does not leak existence.
      await this.hasher.verify(input.password, DECOY_HASH);
      throw HttpError.unauthorized('invalid credentials');
    }
    const stored = await this.repos.users.getPasswordHash(user.id);
    const ok = stored ? await this.hasher.verify(input.password, stored) : false;
    if (!ok) {
      await this.audit(meta, user.id, 'auth.login.fail', user.id);
      throw HttpError.unauthorized('invalid credentials');
    }
    const roles = await this.repos.users.rolesOf(user.id);
    const tokens = await this.startSession(user, roles, meta);
    await this.audit(meta, user.id, 'auth.login', user.id);
    return { user, roles, tokens };
  }

  /** Rotate a refresh token, detecting reuse of an already-rotated token. */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<AuthResult> {
    const hash = hashRefreshToken(refreshToken);
    const session = await this.repos.sessions.findByRefreshHash(hash);
    if (!session) {
      await this.audit(meta, null, 'auth.refresh.unknown', null);
      throw HttpError.unauthorized('invalid refresh token');
    }
    const now = this.clock.now();
    if (session.revokedAt) {
      // The token was already rotated away — reuse implies theft. Burn the chain.
      await this.revokeAllForUser(session.userId, now);
      await this.audit(meta, session.userId, 'auth.refresh.reuse', session.id);
      throw HttpError.unauthorized('refresh token has been revoked');
    }
    if (session.expiresAt.getTime() <= now) {
      throw HttpError.unauthorized('refresh token has expired');
    }

    const user = await this.repos.users.findById(session.userId);
    if (!user) {
      await this.repos.sessions.revoke(session.id, new Date(now));
      throw HttpError.unauthorized('account no longer exists');
    }
    const roles = await this.repos.users.rolesOf(user.id);

    const tokens = await this.startSession(user, roles, meta, session.id);
    await this.repos.sessions.revoke(session.id, new Date(now));
    await this.audit(meta, user.id, 'auth.refresh', session.id);
    return { user, roles, tokens };
  }

  /**
   * Revoke the session behind a refresh token (idempotent). The session must
   * belong to `actingUserId`, so an authenticated caller cannot revoke another
   * user's session by submitting their token.
   */
  async logout(refreshToken: string, meta: RequestMeta, actingUserId: string): Promise<void> {
    const session = await this.repos.sessions.findByRefreshHash(hashRefreshToken(refreshToken));
    if (session && session.userId === actingUserId && !session.revokedAt) {
      await this.repos.sessions.revoke(session.id, new Date(this.clock.now()));
      await this.audit(meta, session.userId, 'auth.logout', session.id);
    }
  }

  /** List a user's sessions (most recent first). */
  listSessions(userId: string): Promise<SessionRow[]> {
    return this.repos.sessions.listForUser(userId);
  }

  private async startSession(
    user: UserRow,
    roles: readonly Role[],
    meta: RequestMeta,
    rotatedFrom?: string,
  ): Promise<TokenPair> {
    const now = this.clock.now();
    const refreshToken = generateRefreshToken();
    const expiresAt = new Date(now + this.refreshTtlSec * 1000);
    await this.repos.sessions.create({
      id: this.ids.next(),
      userId: user.id,
      refreshHash: hashRefreshToken(refreshToken),
      expiresAt,
      ip: meta.ip,
      userAgent: meta.userAgent,
      ...(rotatedFrom ? { rotatedFrom } : {}),
    });
    const { token, claims } = this.tokens.issue({ userId: user.id, handle: user.handle, roles });
    return {
      accessToken: token,
      tokenType: 'Bearer',
      expiresIn: claims.exp - claims.iat,
      refreshToken,
      refreshExpiresAt: expiresAt.toISOString(),
    };
  }

  private async revokeAllForUser(userId: string, now: number): Promise<void> {
    const sessions = await this.repos.sessions.listForUser(userId);
    const at = new Date(now);
    for (const s of sessions) {
      if (!s.revokedAt) await this.repos.sessions.revoke(s.id, at);
    }
  }

  private async audit(
    meta: RequestMeta,
    actorId: string | null,
    action: string,
    target: string | null,
  ): Promise<void> {
    await this.repos.audit.record({
      actorId,
      action,
      target,
      requestId: meta.requestId,
      traceId: meta.traceId ?? null,
      ip: meta.ip,
      userAgent: meta.userAgent,
      at: this.clock.now(),
    });
  }
}

/** SHA-256 of a normalized email, for privacy-preserving uniqueness/lookup. */
export function emailHash(email: string): Buffer {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest();
}
