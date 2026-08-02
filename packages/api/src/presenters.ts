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
  BotAggregateReport,
  StoredBotReport,
  GameBotReport,
  BotBehaviorReport,
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

/** View of an account-level aggregated bot-detection report. */
export interface BotAggregateView {
  readonly playerId: string;
  readonly suspicion: Suspicion;
  readonly gamesAnalyzed: number;
  readonly pooledSampleSize: number;
  readonly pooledMeanMs: number;
  readonly pooledStdevMs: number;
  readonly pooledCoefficientOfVariation: number;
  readonly pooledInstantMoves: number;
  readonly pooledInstantFraction: number;
  readonly lowConfidence: boolean;
  readonly flaggedGameIds: string[];
}

export function botAggregateView(
  playerId: string,
  r: BotAggregateReport,
): BotAggregateView {
  return {
    playerId,
    suspicion: r.suspicion,
    gamesAnalyzed: r.gamesAnalyzed,
    pooledSampleSize: r.pooledSampleSize,
    pooledMeanMs: r.pooledMeanMs,
    pooledStdevMs: r.pooledStdevMs,
    pooledCoefficientOfVariation: r.pooledCoefficientOfVariation,
    pooledInstantMoves: r.pooledInstantMoves,
    pooledInstantFraction: r.pooledInstantFraction,
    lowConfidence: r.lowConfidence,
    flaggedGameIds: [...r.flaggedGameIds],
  };
}

/** View of a per-game stored player bot behavior report. */
export interface BotGameReportView {
  readonly gameId: string;
  readonly playerId: string;
  readonly color: 'white' | 'black';
  readonly report: BotBehaviorReport;
}

export function botGameReportView(
  s: StoredBotReport,
): BotGameReportView {
  return {
    gameId: s.gameId,
    playerId: s.playerId,
    color: s.color,
    report: s.report,
  };
}

export interface BotGameAnalysisView {
  readonly white: BotBehaviorReport;
  readonly black: BotBehaviorReport;
}

export function botGameAnalysisView(
  r: GameBotReport,
): BotGameAnalysisView {
  return {
    white: r.white,
    black: r.black,
  };
}


function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export interface FollowEdgeView {
  readonly followerId: string;
  readonly followeeId: string;
  readonly followedAt: string;
}

export function followEdgeView(edge: import('@chess-platform/social').FollowEdge): FollowEdgeView {
  return {
    followerId: edge.followerId,
    followeeId: edge.followeeId,
    followedAt: edge.followedAt.toISOString(),
  };
}

export interface FriendRequestView {
  readonly id: string;
  readonly requesterId: string;
  readonly addresseeId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly respondedAt: string | null;
}

export function friendRequestView(req: import('@chess-platform/social').FriendRequest): FriendRequestView {
  return {
    id: req.id,
    requesterId: req.requesterId,
    addresseeId: req.addresseeId,
    status: req.status,
    createdAt: req.createdAt.toISOString(),
    respondedAt: req.respondedAt ? req.respondedAt.toISOString() : null,
  };
}

export interface BlockEdgeView {
  readonly blockerId: string;
  readonly blockedId: string;
  readonly blockedAt: string;
}

export function blockEdgeView(edge: import('@chess-platform/social').BlockEdge): BlockEdgeView {
  return {
    blockerId: edge.blockerId,
    blockedId: edge.blockedId,
    blockedAt: edge.blockedAt.toISOString(),
  };
}

export interface ConversationView {
  readonly id: string;
  readonly participantA: string;
  readonly participantB: string;
  readonly createdAt: string;
  readonly lastMessageAt: string;
}

export function conversationView(c: import('@chess-platform/messaging').Conversation): ConversationView {
  return {
    id: c.id,
    participantA: c.participantA,
    participantB: c.participantB,
    createdAt: c.createdAt.toISOString(),
    lastMessageAt: c.lastMessageAt.toISOString(),
  };
}

export interface MessageView {
  readonly id: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly body: string;
  readonly sentAt: string;
  readonly editedAt: string | null;
  readonly deletedAt: string | null;
}

export function messageView(m: import('@chess-platform/messaging').Message): MessageView {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    body: m.body,
    sentAt: m.sentAt.toISOString(),
    editedAt: m.editedAt ? m.editedAt.toISOString() : null,
    deletedAt: m.deletedAt ? m.deletedAt.toISOString() : null,
  };
}

export interface ConversationSummaryView {
  readonly conversation: ConversationView;
  readonly unreadCount: number;
  readonly lastMessage: MessageView | null;
}

export function conversationSummaryView(
  s: import('@chess-platform/messaging').ConversationSummary
): ConversationSummaryView {
  return {
    conversation: conversationView(s.conversation),
    unreadCount: s.unreadCount,
    lastMessage: s.lastMessage ? messageView(s.lastMessage) : null,
  };
}

export interface ConversationReadStateView {
  readonly conversationId: string;
  readonly participantId: string;
  readonly lastReadAt: string;
}

export function conversationReadStateView(
  r: import('@chess-platform/messaging').ConversationReadState
): ConversationReadStateView {
  return {
    conversationId: r.conversationId,
    participantId: r.participantId,
    lastReadAt: r.lastReadAt.toISOString(),
  };
}

export interface TeamView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly visibility: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export function teamView(t: import('@chess-platform/community').Team): TeamView {
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    description: t.description,
    visibility: t.visibility,
    createdBy: t.createdBy,
    createdAt: t.createdAt.toISOString(),
  };
}

export interface MembershipView {
  readonly teamId: string;
  readonly playerId: string;
  readonly role: string;
  readonly joinedAt: string;
}

export function membershipView(m: import('@chess-platform/community').Membership): MembershipView {
  return {
    teamId: m.teamId,
    playerId: m.playerId,
    role: m.role,
    joinedAt: m.joinedAt.toISOString(),
  };
}

export interface JoinRequestView {
  readonly id: string;
  readonly teamId: string;
  readonly playerId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly respondedAt: string | null;
}

export function joinRequestView(j: import('@chess-platform/community').JoinRequest): JoinRequestView {
  return {
    id: j.id,
    teamId: j.teamId,
    playerId: j.playerId,
    status: j.status,
    createdAt: j.createdAt.toISOString(),
    respondedAt: j.respondedAt ? j.respondedAt.toISOString() : null,
  };
}

export interface ForumThreadView {
  readonly id: string;
  readonly teamId: string;
  readonly authorId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly lastPostAt: string;
  readonly locked: boolean;
  readonly pinned: boolean;
  readonly deletedAt: string | null;
}

export function forumThreadView(th: import('@chess-platform/community').ForumThread): ForumThreadView {
  return {
    id: th.id,
    teamId: th.teamId,
    authorId: th.authorId,
    title: th.title,
    createdAt: th.createdAt.toISOString(),
    lastPostAt: th.lastPostAt.toISOString(),
    locked: th.locked,
    pinned: th.pinned,
    deletedAt: th.deletedAt ? th.deletedAt.toISOString() : null,
  };
}

export interface ForumPostView {
  readonly id: string;
  readonly threadId: string;
  readonly authorId: string;
  readonly body: string;
  readonly createdAt: string;
  readonly editedAt: string | null;
  readonly deletedAt: string | null;
}

export function forumPostView(p: import('@chess-platform/community').ForumPost): ForumPostView {
  return {
    id: p.id,
    threadId: p.threadId,
    authorId: p.authorId,
    body: p.body,
    createdAt: p.createdAt.toISOString(),
    editedAt: p.editedAt ? p.editedAt.toISOString() : null,
    deletedAt: p.deletedAt ? p.deletedAt.toISOString() : null,
  };
}


