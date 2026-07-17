/**
 * @packageDocumentation
 * Repository contracts and row types for the relational projections and identity
 * tables. These are driver-agnostic interfaces; the Postgres implementations live
 * in `./pg/repositories`. Domain enumerations are reused from the domain packages
 * so the DB layer and the engine can never drift.
 */

import type { Variant } from '@chess-platform/core';
import type { ResultString, Termination, TimeControl } from '@chess-platform/game';

/** Time-control speed bucket (mirror of `classifySpeed` in @chess-platform/game). */
export type Speed = 'ultrabullet' | 'bullet' | 'blitz' | 'rapid' | 'classical' | 'correspondence';

/** RBAC roles enforced at the gateway and re-checked in services. */
export type Role = 'user' | 'coach' | 'tournament_director' | 'moderator' | 'admin';

// --- Users / identity ------------------------------------------------------

export interface UserRow {
  readonly id: string;
  readonly handle: string;
  readonly emailHash: Buffer | null;
  readonly country: string | null;
  readonly flags: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface NewUser {
  readonly id: string;
  readonly handle: string;
  readonly emailHash?: Buffer | null;
  readonly country?: string | null;
}

export interface UsersRepository {
  create(user: NewUser): Promise<UserRow>;
  /** Atomically create the user, password credential, and initial role. */
  createWithPasswordAndRole(user: NewUser, secretHash: string, role: Role): Promise<UserRow>;
  findById(id: string): Promise<UserRow | null>;
  findByHandle(handle: string): Promise<UserRow | null>;
  /** Upsert the argon2id-encoded password hash for a user. */
  setPassword(userId: string, secretHash: string): Promise<void>;
  getPasswordHash(userId: string): Promise<string | null>;
  addRole(userId: string, role: Role): Promise<void>;
  rolesOf(userId: string): Promise<Role[]>;
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
  listOpen(limit: number): Promise<SeekRow[]>;
  remove(id: string): Promise<void>;
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
  save(snapshot: TournamentAnySnapshot): Promise<void>;
  findById(id: string): Promise<TournamentAnySnapshot | null>;
  list(limit: number): Promise<TournamentSummaryRow[]>;
}
