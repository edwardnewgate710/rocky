/**
 * @packageDocumentation
 * Presenters map internal row types to the stable public JSON shapes returned by
 * the API. Keeping serialization in one place means the wire contract (and the
 * OpenAPI schemas that describe it) never drifts from what handlers emit, and no
 * sensitive column (password/refresh hashes, raw email) is ever exposed.
 */

import type {
  GameSummaryRow,
  RatingRow,
  Role,
  SeekRow,
  SessionRow,
  UserRow,
} from '@chess-platform/persistence';
import type {
  PlayerCorrelationReport,
  GameCorrelationReport,
  PlayerAggregateReport,
  StoredPlayerReport,
  Suspicion,
} from '@chess-platform/anti-cheat';
import { classifySpeed } from '@chess-platform/game';

/** Public user view (safe for any caller). */
export interface PublicUser {
  readonly id: string;
  readonly handle: string;
  readonly country: string | null;
  readonly createdAt: string;
}

export function publicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    handle: user.handle,
    country: user.country,
    createdAt: user.createdAt.toISOString(),
  };
}

/** The caller's own account view, including granted roles. */
export interface SelfUser extends PublicUser {
  readonly roles: readonly Role[];
}

export function selfUser(user: UserRow, roles: readonly Role[]): SelfUser {
  return { ...publicUser(user), roles: [...roles] };
}

/** A rating on the public 1500-centered scale. */
export interface RatingView {
  readonly variant: string;
  readonly rating: number;
  readonly rd: number;
  readonly vol: number;
  readonly updatedAt: string | null;
}

export function ratingView(row: RatingRow): RatingView {
  return {
    variant: row.variant,
    rating: round2(row.rating),
    rd: round2(row.rd),
    vol: round4(row.vol),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A leaderboard entry pairs a user handle with a rating. */
export interface LeaderboardEntry {
  readonly userId: string;
  readonly variant: string;
  readonly rating: number;
  readonly rd: number;
}

export function leaderboardEntry(row: RatingRow): LeaderboardEntry {
  return { userId: row.userId, variant: row.variant, rating: round2(row.rating), rd: round2(row.rd) };
}

/** A session view for the account-security screen. */
export interface SessionView {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly lastSeenAt: string | null;
  readonly lastIp: string | null;
  readonly lastUserAgent: string | null;
}

export function sessionView(row: SessionRow): SessionView {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    lastIp: row.lastIp,
    lastUserAgent: row.lastUserAgent,
  };
}

/** A lobby seek view, enriched with the derived speed bucket. */
export interface SeekView {
  readonly id: string;
  readonly creatorId: string;
  readonly variant: string;
  readonly speed: string;
  readonly timeControl: SeekRow['timeControl'];
  readonly rated: boolean;
  readonly color: SeekRow['color'];
  readonly minRating: number | null;
  readonly maxRating: number | null;
  readonly createdAt: string;
  readonly gameId: string | null;
  readonly acceptedAt: string | null;
}

export function seekView(row: SeekRow): SeekView {
  return {
    id: row.id,
    creatorId: row.creatorId,
    variant: row.variant,
    speed: classifySpeed(row.timeControl),
    timeControl: row.timeControl,
    rated: row.rated,
    color: row.color,
    minRating: row.minRating,
    maxRating: row.maxRating,
    createdAt: row.createdAt.toISOString(),
    gameId: row.gameId,
    acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
  };
}

/** A finished/ongoing game summary view. */
export interface GameSummaryView {
  readonly id: string;
  readonly variant: string;
  readonly rated: boolean;
  readonly speed: string;
  readonly whiteId: string | null;
  readonly blackId: string | null;
  readonly result: string | null;
  readonly termination: string | null;
  readonly plyCount: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export function gameSummaryView(row: GameSummaryRow): GameSummaryView {
  return {
    id: row.id,
    variant: row.variant,
    rated: row.rated,
    speed: row.speed,
    whiteId: row.whiteId,
    blackId: row.blackId,
    result: row.result,
    termination: row.termination,
    plyCount: row.plyCount,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
  };
}

/** View of an account-level aggregated anti-cheat report. */
export interface AntiCheatAggregateView {
  readonly playerId: string;
  readonly suspicion: Suspicion;
  readonly gamesAnalyzed: number;
  readonly pooledSampleSize: number;
  readonly pooledTRateSampleCount: number;
  readonly acpl: number;
  readonly acplCapped: number;
  readonly t1Rate: number;
  readonly t3Rate: number;
  readonly lowConfidence: boolean;
  readonly flaggedGameIds: string[];
}

export function antiCheatAggregateView(
  playerId: string,
  r: PlayerAggregateReport,
): AntiCheatAggregateView {
  return {
    playerId,
    suspicion: r.suspicion,
    gamesAnalyzed: r.gamesAnalyzed,
    pooledSampleSize: r.pooledSampleSize,
    pooledTRateSampleCount: r.pooledTRateSampleCount,
    acpl: r.acpl,
    acplCapped: r.acplCapped,
    t1Rate: r.t1Rate,
    t3Rate: r.t3Rate,
    lowConfidence: r.lowConfidence,
    flaggedGameIds: [...r.flaggedGameIds],
  };
}

/** View of a per-game stored player anti-cheat report. */
export interface AntiCheatGameReportView {
  readonly gameId: string;
  readonly playerId: string;
  readonly color: 'white' | 'black';
  readonly report: PlayerCorrelationReport;
}

export function antiCheatGameReportView(
  s: StoredPlayerReport,
): AntiCheatGameReportView {
  return {
    gameId: s.gameId,
    playerId: s.playerId,
    color: s.color,
    report: s.report,
  };
}

export interface AntiCheatGameAnalysisView {
  readonly white: PlayerCorrelationReport;
  readonly black: PlayerCorrelationReport;
}

export function antiCheatGameAnalysisView(
  report: GameCorrelationReport,
): AntiCheatGameAnalysisView {
  return {
    white: report.white,
    black: report.black,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
