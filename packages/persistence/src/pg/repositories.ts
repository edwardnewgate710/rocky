/**
 * @packageDocumentation
 * Postgres implementations of the repository contracts in `../repositories`.
 * Hand-written SQL (no ORM); controlled-value columns are guarded by lookup-table
 * FKs and CHECK constraints in the schema, so string casts here are safe.
 */

import type { Pool, PoolClient } from 'pg';
import type { Variant } from '@chess-platform/core';
import type { ResultString, Termination, TimeControl } from '@chess-platform/game';
import type {
  GameFinish,
  GameStart,
  GameSummaryRow,
  GamesRepository,
  NewSeek,
  NewSession,
  NewUser,
  RatingRow,
  RatingsRepository,
  Role,
  SeekColor,
  SeekRow,
  SeeksRepository,
  SessionRow,
  SessionRotationResult,
  SessionsRepository,
  Speed,
  TournamentSummaryRow,
  TournamentsRepository,
  TournamentAnySnapshot,
  UserRow,
  UsersRepository,
} from '../repositories';
import { DuplicateUserError, VersionConflictError } from '../errors';

// --- row shapes as returned by pg ------------------------------------------


interface UserDbRow {
  id: string;
  handle: string;
  email_hash: Buffer | null;
  country: string | null;
  flags: Record<string, unknown>;
  created_at: Date;
}

interface SessionDbRow {
  id: string;
  user_id: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  rotated_from: string | null;
  last_seen_at: Date | null;
  last_ip: string | null;
  last_user_agent: string | null;
}

interface RatingDbRow {
  user_id: string;
  variant: string;
  rating: number;
  rd: number;
  vol: number;
  updated_at: Date;
}

interface GameDbRow {
  id: string;
  variant: string;
  rated: boolean;
  speed: string;
  white_id: string | null;
  black_id: string | null;
  result: string | null;
  termination: string | null;
  ply_count: number;
  last_seq: number;
  started_at: Date;
  ended_at: Date | null;
}

interface SeekDbRow {
  id: string;
  creator_id: string;
  variant: string;
  time_control: TimeControl;
  rated: boolean;
  color: string;
  min_rating: number | null;
  max_rating: number | null;
  created_at: Date;
}

interface TournamentDbRow {
  id: string;
  name: string;
  format: 'round_robin' | 'swiss' | 'arena';
  state: 'registration' | 'running' | 'finished';
  participant_count: number;
  snapshot: TournamentAnySnapshot;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function toUser(r: UserDbRow): UserRow {
  return {
    id: r.id,
    handle: r.handle,
    emailHash: r.email_hash,
    country: r.country,
    flags: r.flags,
    createdAt: r.created_at,
  };
}

function toSession(r: SessionDbRow): SessionRow {
  return {
    id: r.id,
    userId: r.user_id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    rotatedFrom: r.rotated_from,
    lastSeenAt: r.last_seen_at,
    lastIp: r.last_ip,
    lastUserAgent: r.last_user_agent,
  };
}

function toRating(r: RatingDbRow): RatingRow {
  return {
    userId: r.user_id,
    variant: r.variant as Variant,
    rating: r.rating,
    rd: r.rd,
    vol: r.vol,
    updatedAt: r.updated_at,
  };
}

function toGame(r: GameDbRow): GameSummaryRow {
  return {
    id: r.id,
    variant: r.variant as Variant,
    rated: r.rated,
    speed: r.speed as Speed,
    whiteId: r.white_id,
    blackId: r.black_id,
    result: r.result as ResultString | null,
    termination: r.termination as Termination | null,
    plyCount: r.ply_count,
    lastSeq: r.last_seq,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

function toSeek(r: SeekDbRow): SeekRow {
  return {
    id: r.id,
    creatorId: r.creator_id,
    variant: r.variant as Variant,
    timeControl: r.time_control,
    rated: r.rated,
    color: r.color as SeekColor,
    minRating: r.min_rating,
    maxRating: r.max_rating,
    createdAt: r.created_at,
  };
}

const SESSION_COLS =
  'id, user_id, created_at, expires_at, revoked_at, rotated_from, last_seen_at, last_ip, last_user_agent';
const GAME_COLS =
  'id, variant, rated, speed, white_id, black_id, result, termination, ply_count, last_seq, started_at, ended_at';

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    (error as { code?: unknown }).code === '23505';
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original failure.
  }
}

export class PgUsersRepository implements UsersRepository {
  constructor(private readonly pool: Pool) {}

  async create(user: NewUser): Promise<UserRow> {
    const res = await this.pool.query<UserDbRow>(
      `INSERT INTO users (id, handle, email_hash, country)
       VALUES ($1, $2, $3, $4)
       RETURNING id, handle, email_hash, country, flags, created_at`,
      [user.id, user.handle, user.emailHash ?? null, user.country ?? null],
    );
    return toUser(res.rows[0]!);
  }

  async createWithPasswordAndRole(user: NewUser, secretHash: string, role: Role): Promise<UserRow> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const created = await client.query<UserDbRow>(
        `INSERT INTO users (id, handle, email_hash, country)
         VALUES ($1, $2, $3, $4)
         RETURNING id, handle, email_hash, country, flags, created_at`,
        [user.id, user.handle, user.emailHash ?? null, user.country ?? null],
      );
      await client.query(
        `INSERT INTO credentials (user_id, kind, secret_hash)
         VALUES ($1, 'password', $2)`,
        [user.id, secretHash],
      );
      await client.query(
        'INSERT INTO roles (user_id, role) VALUES ($1, $2)',
        [user.id, role],
      );
      await client.query('COMMIT');
      return toUser(created.rows[0]!);
    } catch (error) {
      await rollback(client);
      if (isUniqueViolation(error)) throw new DuplicateUserError();
      throw error;
    } finally {
      client.release();
    }
  }

  async findById(id: string): Promise<UserRow | null> {
    const res = await this.pool.query<UserDbRow>(
      'SELECT id, handle, email_hash, country, flags, created_at FROM users WHERE id = $1',
      [id],
    );
    return res.rows[0] ? toUser(res.rows[0]) : null;
  }

  async findByHandle(handle: string): Promise<UserRow | null> {
    const res = await this.pool.query<UserDbRow>(
      'SELECT id, handle, email_hash, country, flags, created_at FROM users WHERE handle = $1',
      [handle],
    );
    return res.rows[0] ? toUser(res.rows[0]) : null;
  }

  async setPassword(userId: string, secretHash: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO credentials (user_id, kind, secret_hash) VALUES ($1, 'password', $2)
       ON CONFLICT (user_id, kind) DO UPDATE SET secret_hash = EXCLUDED.secret_hash, updated_at = now()`,
      [userId, secretHash],
    );
  }

  async getPasswordHash(userId: string): Promise<string | null> {
    const res = await this.pool.query<{ secret_hash: string }>(
      "SELECT secret_hash FROM credentials WHERE user_id = $1 AND kind = 'password'",
      [userId],
    );
    return res.rows[0]?.secret_hash ?? null;
  }

  async addRole(userId: string, role: Role): Promise<void> {
    await this.pool.query(
      'INSERT INTO roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, role],
    );
  }

  async rolesOf(userId: string): Promise<Role[]> {
    const res = await this.pool.query<{ role: string }>(
      'SELECT role FROM roles WHERE user_id = $1 ORDER BY role',
      [userId],
    );
    return res.rows.map((r) => r.role as Role);
  }
}

export class PgSessionsRepository implements SessionsRepository {
  constructor(private readonly pool: Pool) {}

  async create(session: NewSession): Promise<SessionRow> {
    const res = await this.pool.query<SessionDbRow>(
      `INSERT INTO sessions (id, user_id, refresh_hash, expires_at, rotated_from, created_ip, created_user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${SESSION_COLS}`,
      [
        session.id,
        session.userId,
        session.refreshHash,
        session.expiresAt,
        session.rotatedFrom ?? null,
        session.ip ?? null,
        session.userAgent ?? null,
      ],
    );
    return toSession(res.rows[0]!);
  }

  async findActiveById(id: string): Promise<SessionRow | null> {
    const res = await this.pool.query<SessionDbRow>(
      `SELECT ${SESSION_COLS} FROM sessions
       WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [id],
    );
    return res.rows[0] ? toSession(res.rows[0]) : null;
  }

  async findByRefreshHash(refreshHash: string): Promise<SessionRow | null> {
    const res = await this.pool.query<SessionDbRow>(
      `SELECT ${SESSION_COLS} FROM sessions WHERE refresh_hash = $1`,
      [refreshHash],
    );
    return res.rows[0] ? toSession(res.rows[0]) : null;
  }

  async rotate(
    refreshHash: string,
    replacement: NewSession,
    at: Date,
  ): Promise<SessionRotationResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<SessionDbRow>(
        `SELECT ${SESSION_COLS} FROM sessions
         WHERE refresh_hash = $1 FOR UPDATE`,
        [refreshHash],
      );
      const row = found.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return { status: 'missing' };
      }
      const previous = toSession(row);
      if (previous.revokedAt !== null) {
        await client.query('COMMIT');
        return { status: 'revoked', previous };
      }
      if (previous.expiresAt.getTime() <= at.getTime()) {
        await client.query('COMMIT');
        return { status: 'expired', previous };
      }

      await client.query('UPDATE sessions SET revoked_at = $2 WHERE id = $1', [previous.id, at]);
      const inserted = await client.query<SessionDbRow>(
        `INSERT INTO sessions (id, user_id, refresh_hash, expires_at, rotated_from, created_ip, created_user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${SESSION_COLS}`,
        [
          replacement.id,
          replacement.userId,
          replacement.refreshHash,
          replacement.expiresAt,
          replacement.rotatedFrom ?? previous.id,
          replacement.ip ?? null,
          replacement.userAgent ?? null,
        ],
      );
      await client.query('COMMIT');
      return { status: 'rotated', previous, replacement: toSession(inserted.rows[0]!) };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async touch(id: string, at: Date, ip?: string | null, userAgent?: string | null): Promise<void> {
    await this.pool.query(
      'UPDATE sessions SET last_seen_at = $2, last_ip = $3, last_user_agent = $4 WHERE id = $1',
      [id, at, ip ?? null, userAgent ?? null],
    );
  }

  async revoke(id: string, at: Date): Promise<void> {
    await this.pool.query('UPDATE sessions SET revoked_at = $2 WHERE id = $1', [id, at]);
  }

  async listForUser(userId: string): Promise<SessionRow[]> {
    const res = await this.pool.query<SessionDbRow>(
      `SELECT ${SESSION_COLS} FROM sessions WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return res.rows.map(toSession);
  }
}

export class PgRatingsRepository implements RatingsRepository {
  constructor(private readonly pool: Pool) {}

  async get(userId: string, variant: Variant): Promise<RatingRow | null> {
    const res = await this.pool.query<RatingDbRow>(
      'SELECT user_id, variant, rating, rd, vol, updated_at FROM ratings WHERE user_id = $1 AND variant = $2',
      [userId, variant],
    );
    return res.rows[0] ? toRating(res.rows[0]) : null;
  }

  async upsert(row: {
    userId: string;
    variant: Variant;
    rating: number;
    rd: number;
    vol: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO ratings (user_id, variant, rating, rd, vol) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, variant)
       DO UPDATE SET rating = EXCLUDED.rating, rd = EXCLUDED.rd, vol = EXCLUDED.vol, updated_at = now()`,
      [row.userId, row.variant, row.rating, row.rd, row.vol],
    );
  }

  async leaderboard(variant: Variant, limit: number): Promise<RatingRow[]> {
    const res = await this.pool.query<RatingDbRow>(
      `SELECT user_id, variant, rating, rd, vol, updated_at FROM ratings
       WHERE variant = $1 ORDER BY rating DESC LIMIT $2`,
      [variant, limit],
    );
    return res.rows.map(toRating);
  }
}

export class PgGamesRepository implements GamesRepository {
  constructor(private readonly pool: Pool) {}

  async start(game: GameStart): Promise<void> {
    await this.pool.query(
      `INSERT INTO games (id, variant, rated, speed, white_id, black_id, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [game.id, game.variant, game.rated, game.speed, game.whiteId, game.blackId, game.startedAt],
    );
  }

  async updateProgress(id: string, plyCount: number, lastSeq: number): Promise<void> {
    await this.pool.query('UPDATE games SET ply_count = $2, last_seq = $3 WHERE id = $1', [
      id,
      plyCount,
      lastSeq,
    ]);
  }

  async finish(id: string, finish: GameFinish): Promise<void> {
    await this.pool.query(
      `UPDATE games SET result = $2, termination = $3, ply_count = $4, last_seq = $5, ended_at = $6
       WHERE id = $1`,
      [id, finish.result, finish.termination, finish.plyCount, finish.lastSeq, finish.endedAt],
    );
  }

  async findById(id: string): Promise<GameSummaryRow | null> {
    const res = await this.pool.query<GameDbRow>(
      `SELECT ${GAME_COLS} FROM games WHERE id = $1`,
      [id],
    );
    return res.rows[0] ? toGame(res.rows[0]) : null;
  }

  async recentForUser(userId: string, limit: number): Promise<GameSummaryRow[]> {
    const res = await this.pool.query<GameDbRow>(
      `SELECT ${GAME_COLS} FROM games
       WHERE white_id = $1 OR black_id = $1 ORDER BY started_at DESC LIMIT $2`,
      [userId, limit],
    );
    return res.rows.map(toGame);
  }
}

export class PgSeeksRepository implements SeeksRepository {
  constructor(private readonly pool: Pool) {}

  async create(seek: NewSeek): Promise<SeekRow> {
    const res = await this.pool.query<SeekDbRow>(
      `INSERT INTO seeks (id, creator_id, variant, time_control, rated, color, min_rating, max_rating)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
       RETURNING id, creator_id, variant, time_control, rated, color, min_rating, max_rating, created_at`,
      [
        seek.id,
        seek.creatorId,
        seek.variant,
        JSON.stringify(seek.timeControl),
        seek.rated,
        seek.color ?? 'random',
        seek.minRating ?? null,
        seek.maxRating ?? null,
      ],
    );
    return toSeek(res.rows[0]!);
  }

  async findById(id: string): Promise<SeekRow | null> {
    const res = await this.pool.query<SeekDbRow>(
      `SELECT id, creator_id, variant, time_control, rated, color, min_rating, max_rating, created_at
       FROM seeks WHERE id = $1`,
      [id],
    );
    return res.rows[0] ? toSeek(res.rows[0]) : null;
  }

  async listOpen(limit: number): Promise<SeekRow[]> {
    const res = await this.pool.query<SeekDbRow>(
      `SELECT id, creator_id, variant, time_control, rated, color, min_rating, max_rating, created_at
       FROM seeks ORDER BY created_at ASC LIMIT $1`,
      [limit],
    );
    return res.rows.map(toSeek);
  }

  async remove(id: string): Promise<void> {
    await this.pool.query('DELETE FROM seeks WHERE id = $1', [id]);
  }
}

export class PgTournamentsRepository implements TournamentsRepository {
  constructor(private readonly pool: Pool) {}

  async save(snapshot: TournamentAnySnapshot, expectedVersion: number): Promise<void> {
    if (expectedVersion === 0) {
      try {
        await this.pool.query(
          `INSERT INTO tournaments (id, name, format, state, participant_count, snapshot, version)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, 1)`,
          [
            snapshot.config.id,
            snapshot.config.name,
            snapshot.config.format,
            snapshot.state,
            snapshot.participants.length,
            JSON.stringify(snapshot),
          ]
        );
      } catch (err: any) {
        if (isUniqueViolation(err)) {
          throw new VersionConflictError(snapshot.config.id, expectedVersion);
        }
        throw err;
      }
    } else {
      const res = await this.pool.query(
        `UPDATE tournaments SET
           name = $2,
           format = $3,
           state = $4,
           participant_count = $5,
           snapshot = $6::jsonb,
           version = version + 1,
           updated_at = now()
         WHERE id = $1 AND version = $7`,
        [
          snapshot.config.id,
          snapshot.config.name,
          snapshot.config.format,
          snapshot.state,
          snapshot.participants.length,
          JSON.stringify(snapshot),
          expectedVersion,
        ]
      );
      if (res.rowCount === 0) {
        throw new VersionConflictError(snapshot.config.id, expectedVersion);
      }
    }
  }

  async findById(id: string): Promise<{ snapshot: TournamentAnySnapshot; version: number } | null> {
    const res = await this.pool.query<TournamentDbRow>(
      'SELECT snapshot, version FROM tournaments WHERE id = $1',
      [id]
    );
    return res.rows[0]
      ? { snapshot: res.rows[0].snapshot as TournamentAnySnapshot, version: res.rows[0].version }
      : null;
  }

  async list(limit: number): Promise<TournamentSummaryRow[]> {
    const res = await this.pool.query<TournamentDbRow>(
      `SELECT id, name, format, state, participant_count
       FROM tournaments ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return res.rows.map(r => ({
      id: r.id,
      name: r.name,
      format: r.format,
      state: r.state,
      participantCount: r.participant_count,
    }));
  }
}
