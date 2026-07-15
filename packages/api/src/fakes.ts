/**
 * @packageDocumentation
 * In-memory implementations of every repository the API consumes. They exist so
 * the whole service can be exercised end-to-end — in tests and in local dev —
 * with zero external infrastructure, while behaving like the Postgres
 * implementations (case-insensitive handles, active-session filtering, ordering).
 * The Postgres implementations remain the production wiring; these fakes are the
 * contract's executable specification.
 */

import type { Variant } from '@chess-platform/core';
import type {
  GameFinish,
  GamesRepository,
  GameStart,
  GameSummaryRow,
  NewSeek,
  NewSession,
  NewUser,
  RatingRow,
  RatingsRepository,
  Role,
  SeekRow,
  SeeksRepository,
  SessionRow,
  SessionsRepository,
  UserRow,
  UsersRepository,
} from '@chess-platform/persistence';
import type { AuditEntry, AuditRepository } from './ports/audit';
import type { Clock } from './ports/clock';
import { systemClock } from './ports/clock';
import type { Repositories } from './deps';

export class InMemoryUsersRepository implements UsersRepository {
  private readonly byId = new Map<string, UserRow>();
  private readonly passwords = new Map<string, string>();
  private readonly roles = new Map<string, Set<Role>>();

  constructor(private readonly clock: Clock = systemClock) {}

  async create(user: NewUser): Promise<UserRow> {
    const row: UserRow = {
      id: user.id,
      handle: user.handle,
      emailHash: user.emailHash ?? null,
      country: user.country ?? null,
      flags: {},
      createdAt: new Date(this.clock.now()),
    };
    this.byId.set(row.id, row);
    return row;
  }

  async findById(id: string): Promise<UserRow | null> {
    return this.byId.get(id) ?? null;
  }

  async findByHandle(handle: string): Promise<UserRow | null> {
    const lower = handle.toLowerCase();
    for (const row of this.byId.values()) {
      if (row.handle.toLowerCase() === lower) return row;
    }
    return null;
  }

  async setPassword(userId: string, secretHash: string): Promise<void> {
    this.passwords.set(userId, secretHash);
  }

  async getPasswordHash(userId: string): Promise<string | null> {
    return this.passwords.get(userId) ?? null;
  }

  async addRole(userId: string, role: Role): Promise<void> {
    const set = this.roles.get(userId) ?? new Set<Role>();
    set.add(role);
    this.roles.set(userId, set);
  }

  async rolesOf(userId: string): Promise<Role[]> {
    return [...(this.roles.get(userId) ?? [])];
  }
}

interface StoredSession {
  row: SessionRow;
  refreshHash: string;
  seq: number;
}

export class InMemorySessionsRepository implements SessionsRepository {
  private readonly byId = new Map<string, StoredSession>();
  private seq = 0;

  constructor(private readonly clock: Clock = systemClock) {}

  async create(session: NewSession): Promise<SessionRow> {
    const row: SessionRow = {
      id: session.id,
      userId: session.userId,
      createdAt: new Date(this.clock.now()),
      expiresAt: session.expiresAt,
      revokedAt: null,
      rotatedFrom: session.rotatedFrom ?? null,
      lastSeenAt: null,
      lastIp: null,
      lastUserAgent: null,
    };
    this.byId.set(row.id, { row, refreshHash: session.refreshHash, seq: this.seq++ });
    return row;
  }

  async findActiveById(id: string): Promise<SessionRow | null> {
    const stored = this.byId.get(id);
    if (!stored) return null;
    const { row } = stored;
    if (row.revokedAt || row.expiresAt.getTime() <= this.clock.now()) return null;
    return row;
  }

  async findByRefreshHash(refreshHash: string): Promise<SessionRow | null> {
    for (const stored of this.byId.values()) {
      if (stored.refreshHash === refreshHash) return stored.row;
    }
    return null;
  }

  async touch(id: string, at: Date, ip?: string | null, userAgent?: string | null): Promise<void> {
    const stored = this.byId.get(id);
    if (!stored) return;
    stored.row = { ...stored.row, lastSeenAt: at, lastIp: ip ?? null, lastUserAgent: userAgent ?? null };
  }

  async revoke(id: string, at: Date): Promise<void> {
    const stored = this.byId.get(id);
    if (!stored) return;
    stored.row = { ...stored.row, revokedAt: at };
  }

  async listForUser(userId: string): Promise<SessionRow[]> {
    return [...this.byId.values()]
      .filter((s) => s.row.userId === userId)
      .sort((a, b) => b.seq - a.seq)
      .map((s) => s.row);
  }
}

function ratingKey(userId: string, variant: Variant): string {
  return `${userId}:${variant}`;
}

export class InMemoryRatingsRepository implements RatingsRepository {
  private readonly byKey = new Map<string, RatingRow>();

  constructor(private readonly clock: Clock = systemClock) {}

  async get(userId: string, variant: Variant): Promise<RatingRow | null> {
    return this.byKey.get(ratingKey(userId, variant)) ?? null;
  }

  async upsert(row: {
    userId: string;
    variant: Variant;
    rating: number;
    rd: number;
    vol: number;
  }): Promise<void> {
    this.byKey.set(ratingKey(row.userId, row.variant), {
      ...row,
      updatedAt: new Date(this.clock.now()),
    });
  }

  async leaderboard(variant: Variant, limit: number): Promise<RatingRow[]> {
    return [...this.byKey.values()]
      .filter((r) => r.variant === variant)
      .sort((a, b) => b.rating - a.rating)
      .slice(0, limit);
  }
}

export class InMemoryGamesRepository implements GamesRepository {
  private readonly byId = new Map<string, GameSummaryRow>();
  private seq = 0;
  private readonly order = new Map<string, number>();

  async start(game: GameStart): Promise<void> {
    const row: GameSummaryRow = {
      id: game.id,
      variant: game.variant,
      rated: game.rated,
      speed: game.speed,
      whiteId: game.whiteId,
      blackId: game.blackId,
      result: null,
      termination: null,
      plyCount: 0,
      lastSeq: 0,
      startedAt: game.startedAt,
      endedAt: null,
    };
    this.byId.set(row.id, row);
    this.order.set(row.id, this.seq++);
  }

  async updateProgress(id: string, plyCount: number, lastSeq: number): Promise<void> {
    const row = this.byId.get(id);
    if (row) this.byId.set(id, { ...row, plyCount, lastSeq });
  }

  async finish(id: string, finish: GameFinish): Promise<void> {
    const row = this.byId.get(id);
    if (row) {
      this.byId.set(id, {
        ...row,
        result: finish.result,
        termination: finish.termination,
        plyCount: finish.plyCount,
        lastSeq: finish.lastSeq,
        endedAt: finish.endedAt,
      });
    }
  }

  async findById(id: string): Promise<GameSummaryRow | null> {
    return this.byId.get(id) ?? null;
  }

  async recentForUser(userId: string, limit: number): Promise<GameSummaryRow[]> {
    return [...this.byId.values()]
      .filter((g) => g.whiteId === userId || g.blackId === userId)
      .sort((a, b) => (this.order.get(b.id) ?? 0) - (this.order.get(a.id) ?? 0))
      .slice(0, limit);
  }
}

export class InMemorySeeksRepository implements SeeksRepository {
  private readonly byId = new Map<string, SeekRow>();
  private seq = 0;
  private readonly order = new Map<string, number>();

  constructor(private readonly clock: Clock = systemClock) {}

  async create(seek: NewSeek): Promise<SeekRow> {
    const row: SeekRow = {
      id: seek.id,
      creatorId: seek.creatorId,
      variant: seek.variant,
      timeControl: seek.timeControl,
      rated: seek.rated,
      color: seek.color ?? 'random',
      minRating: seek.minRating ?? null,
      maxRating: seek.maxRating ?? null,
      createdAt: new Date(this.clock.now()),
    };
    this.byId.set(row.id, row);
    this.order.set(row.id, this.seq++);
    return row;
  }

  async findById(id: string): Promise<SeekRow | null> {
    return this.byId.get(id) ?? null;
  }

  async listOpen(limit: number): Promise<SeekRow[]> {
    return [...this.byId.values()]
      .sort((a, b) => (this.order.get(a.id) ?? 0) - (this.order.get(b.id) ?? 0))
      .slice(0, limit);
  }

  async remove(id: string): Promise<void> {
    this.byId.delete(id);
    this.order.delete(id);
  }
}

export class InMemoryAuditRepository implements AuditRepository {
  private readonly log: AuditEntry[] = [];

  async record(entry: AuditEntry): Promise<void> {
    this.log.push(entry);
  }

  /** All recorded entries (for assertions/inspection). */
  entries(): readonly AuditEntry[] {
    return this.log;
  }

  /** Entries whose action equals `action`. */
  withAction(action: string): readonly AuditEntry[] {
    return this.log.filter((e) => e.action === action);
  }
}

/** A bundle of in-memory repositories plus the concrete audit repo for tests. */
export interface InMemoryRepositories extends Repositories {
  readonly users: InMemoryUsersRepository;
  readonly sessions: InMemorySessionsRepository;
  readonly ratings: InMemoryRatingsRepository;
  readonly games: InMemoryGamesRepository;
  readonly seeks: InMemorySeeksRepository;
  readonly audit: InMemoryAuditRepository;
}

/** Construct a fresh set of in-memory repositories sharing a clock. */
export function createInMemoryRepositories(clock: Clock = systemClock): InMemoryRepositories {
  return {
    users: new InMemoryUsersRepository(clock),
    sessions: new InMemorySessionsRepository(clock),
    ratings: new InMemoryRatingsRepository(clock),
    games: new InMemoryGamesRepository(),
    seeks: new InMemorySeeksRepository(clock),
    audit: new InMemoryAuditRepository(),
  };
}
