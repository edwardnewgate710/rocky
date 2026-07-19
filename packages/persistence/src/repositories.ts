/**
 * @packageDocumentation
 * Repository contracts and row types for the relational projections and identity
 * tables. These are driver-agnostic interfaces; the Postgres implementations live
 * in `./pg/repositories`. Domain enumerations are reused from the domain packages
 * so the DB layer and the engine can never drift.
 */

import type { Variant } from '@chess-platform/core';
import type { ResultString, Termination, TimeControl, GameEvent } from '@chess-platform/game';
/** Time-control speed bucket (mirror of `classifySpeed` in @chess-platform/game). */
export type Speed = 'ultrabullet' | 'bullet' | 'blitz' | 'rapid' | 'classical' | 'correspondence';

/** RBAC roles enforced at the gateway and re-checked in services. */
export type Role = 'user' | 'coach' | 'tournament_director' | 'moderator' | 'admin';

// --- Users / identity ------------------------------------------------------

export interface UserRow {
  readonly id: string;
  readonly handle: string;
  readonly email: string | null;
  readonly emailVerifiedAt: Date | null;
  readonly emailHash: Buffer | null;
  readonly country: string | null;
  readonly flags: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface NewUser {
  readonly id: string;
  readonly handle: string;
  readonly email?: string | null;
  readonly emailVerifiedAt?: Date | null;
  readonly emailHash?: Buffer | null;
  readonly country?: string | null;
}

export interface UsersRepository {
  create(user: NewUser): Promise<UserRow>;
  /** Atomically create the user, password credential, and initial role. */
  createWithPasswordAndRole(user: NewUser, secretHash: string, role: Role): Promise<UserRow>;
  findById(id: string): Promise<UserRow | null>;
  findByHandle(handle: string): Promise<UserRow | null>;
  findByEmail(email: string): Promise<UserRow | null>;
  markEmailVerified(userId: string, at: Date): Promise<void>;
  /** Upsert the argon2id-encoded password hash for a user. */
  setPassword(userId: string, secretHash: string): Promise<void>;
  getPasswordHash(userId: string): Promise<string | null>;
  addRole(userId: string, role: Role): Promise<void>;
  rolesOf(userId: string): Promise<Role[]>;
}

// --- Identity Tokens -------------------------------------------------------

export type IdentityTokenKind = 'password_reset' | 'email_verify' | 'webauthn_register';

export interface IdentityTokenRow {
  readonly tokenHash: string;
  readonly userId: string;
  readonly kind: IdentityTokenKind;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

export interface NewIdentityToken {
  readonly tokenHash: string;
  readonly userId: string;
  readonly kind: IdentityTokenKind;
  readonly expiresAt: Date;
}

export interface IdentityTokensRepository {
  create(token: NewIdentityToken): Promise<IdentityTokenRow>;
  /** Atomically consume a token. Returns null if missing, expired, or already used. */
  consume(tokenHash: string, kind: IdentityTokenKind, at: Date): Promise<IdentityTokenRow | null>;
}

// --- WebAuthn Credentials ----------------------------------------------------

export interface WebAuthnLoginChallengeRow {
  readonly challengeHash: string;
  readonly userId: string | null;
  readonly expiresAt: Date;
}

export interface NewWebAuthnLoginChallenge {
  readonly challengeHash: string;
  readonly userId: string | null;
  readonly expiresAt: Date;
}

export interface WebAuthnLoginChallengesRepository {
  upsert(challenge: NewWebAuthnLoginChallenge): Promise<void>;
  consume(challengeHash: string, at: Date): Promise<WebAuthnLoginChallengeRow | null>;
  cleanup(at: Date): Promise<void>;
}

export interface WebAuthnCredentialRow {
  readonly id: Buffer;            // credential ID (byte array)
  readonly userId: string;
  readonly publicKey: Buffer;
  readonly signCount: number;
  readonly transports: string[];
  readonly name: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

export interface NewWebAuthnCredential {
  readonly id: Buffer;
  readonly userId: string;
  readonly publicKey: Buffer;
  readonly signCount: number;
  readonly transports: string[];
  readonly name: string;
}

export interface WebAuthnCredentialsRepository {
  create(credential: NewWebAuthnCredential): Promise<WebAuthnCredentialRow>;
  findByCredentialId(id: Buffer): Promise<WebAuthnCredentialRow | null>;
  listForUser(userId: string): Promise<WebAuthnCredentialRow[]>;
  updateSignCount(id: Buffer, signCount: number, at: Date): Promise<void>;
  delete(id: Buffer): Promise<void>;
  countForUser(userId: string): Promise<number>;
}

// --- Sessions --------------------------------------------------------------

export interface SessionRow {
  readonly id: string;
  readonly userId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly rotatedFrom: string | null;
  readonly lastSeenAt: Date | null;
  readonly lastIp: string | null;
  readonly lastUserAgent: string | null;
}

export interface NewSession {
  readonly id: string;
  readonly userId: string;
  readonly refreshHash: string;
  readonly expiresAt: Date;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly rotatedFrom?: string | null;
}

export type SessionRotationResult =
  | { readonly status: 'rotated'; readonly previous: SessionRow; readonly replacement: SessionRow }
  | { readonly status: 'missing' }
  | { readonly status: 'revoked'; readonly previous: SessionRow }
  | { readonly status: 'expired'; readonly previous: SessionRow };

export interface SessionsRepository {
  create(session: NewSession): Promise<SessionRow>;
  /** Return a non-revoked, non-expired session, or null. */
  findActiveById(id: string): Promise<SessionRow | null>;
  findByRefreshHash(refreshHash: string): Promise<SessionRow | null>;
  /** Atomically consume a refresh token and insert its replacement session. */
  rotate(refreshHash: string, replacement: NewSession, at: Date): Promise<SessionRotationResult>;
  /** Record activity (last_seen_at / last_ip / last_user_agent). */
  touch(id: string, at: Date, ip?: string | null, userAgent?: string | null): Promise<void>;
  revoke(id: string, at: Date): Promise<void>;
  listForUser(userId: string): Promise<SessionRow[]>;
}

// --- Ratings ---------------------------------------------------------------

export interface RatingRow {
  readonly userId: string;
  readonly variant: Variant;
  readonly rating: number;
  readonly rd: number;
  readonly vol: number;
  readonly updatedAt: Date;
}

export interface RatingsRepository {
  get(userId: string, variant: Variant): Promise<RatingRow | null>;
  upsert(row: {
    userId: string;
    variant: Variant;
    rating: number;
    rd: number;
    vol: number;
  }): Promise<void>;
  leaderboard(variant: Variant, limit: number): Promise<RatingRow[]>;
}

// --- Games projection ------------------------------------------------------

export interface GameSummaryRow {
  readonly id: string;
  readonly variant: Variant;
  readonly rated: boolean;
  readonly speed: Speed;
  readonly whiteId: string | null;
  readonly blackId: string | null;
  readonly result: ResultString | null;
  readonly termination: Termination | null;
  readonly plyCount: number;
  readonly lastSeq: number;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
}

export interface GameStart {
  readonly id: string;
  readonly variant: Variant;
  readonly rated: boolean;
  readonly speed: Speed;
  readonly whiteId: string | null;
  readonly blackId: string | null;
  readonly startedAt: Date;
}

export interface GameFinish {
  readonly result: ResultString;
  readonly termination: Termination;
  readonly plyCount: number;
  readonly lastSeq: number;
  readonly endedAt: Date;
}

export interface GamesRepository {
  start(game: GameStart): Promise<void>;
  updateProgress(id: string, plyCount: number, lastSeq: number): Promise<void>;
  finish(id: string, finish: GameFinish): Promise<void>;
  findById(id: string): Promise<GameSummaryRow | null>;
  recentForUser(userId: string, limit: number): Promise<GameSummaryRow[]>;
}

// --- Seeks / lobby ---------------------------------------------------------

/**
 * The creator's color preference for a seek. `random` (the default) lets the
 * pairing step assign sides; `white`/`black` request that specific side.
 */
export type SeekColor = 'white' | 'black' | 'random';

export interface SeekRow {
  readonly id: string;
  readonly creatorId: string;
  readonly variant: Variant;
  readonly timeControl: TimeControl;
  readonly rated: boolean;
  readonly color: SeekColor;
  readonly minRating: number | null;
  readonly maxRating: number | null;
  readonly createdAt: Date;
  readonly gameId: string | null;
  readonly acceptedAt: Date | null;
}

export interface NewSeek {
  readonly id: string;
  readonly creatorId: string;
  readonly variant: Variant;
  readonly timeControl: TimeControl;
  readonly rated: boolean;
  /** Defaults to `random` when omitted. */
  readonly color?: SeekColor;
  readonly minRating?: number | null;
  readonly maxRating?: number | null;
}

export interface SeeksRepository {
  create(seek: NewSeek): Promise<SeekRow>;
  findById(id: string): Promise<SeekRow | null>;
  /** Returns open seeks. If `creatorId` is provided, also includes that user's latest match receipt. */
  listOpen(limit: number, creatorId?: string): Promise<SeekRow[]>;
  /** Removes an open seek. Returns false when it is missing or has already been accepted. */
  remove(id: string): Promise<boolean>;
  cleanup(at: Date): Promise<void>;
}

export interface SeekAcceptor {
  /**
   * Atomically claims a seek and creates the corresponding game.
   * Both operations happen in a single transaction.
   * Returns the updated seek on success, or null if the seek is missing/already claimed.
   */
  accept(seekId: string, gameId: string, events: readonly GameEvent[], gameStart: GameStart): Promise<SeekRow | null>;
}

// --- Tournaments -----------------------------------------------------------

import type { TournamentSnapshot, ArenaSnapshot } from '@chess-platform/tournament';

export type TournamentAnySnapshot = TournamentSnapshot | ArenaSnapshot;

/**
 * Narrow a stored snapshot to the Arena variant. Both snapshot shapes carry a
 * `config.format` discriminant, so this lets callers branch on the format
 * without unsafe casts.
 */
export function isArenaSnapshot(snapshot: TournamentAnySnapshot): snapshot is ArenaSnapshot {
  return snapshot.config.format === 'arena';
}

export interface TournamentSummaryRow {
  readonly id: string;
  readonly name: string;
  readonly format: 'round_robin' | 'swiss' | 'arena';
  readonly state: 'registration' | 'running' | 'finished';
  readonly participantCount: number;
}

export interface TournamentsRepository {
  save(snapshot: TournamentAnySnapshot, expectedVersion: number): Promise<void>;
  findById(id: string): Promise<{ snapshot: TournamentAnySnapshot; version: number } | null>;
  list(limit: number): Promise<TournamentSummaryRow[]>;
}
