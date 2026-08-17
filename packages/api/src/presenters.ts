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
import { VARIANTS } from './domain.js';

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
  /**
   * Where the session was signed in from. Nothing populates the `last*` fields today, so these are
   * what the account-security screen can actually identify a session by; they are always present
   * for a session created through a real request.
   */
  readonly createdIp: string | null;
  readonly createdUserAgent: string | null;
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
    createdIp: row.createdIp,
    createdUserAgent: row.createdUserAgent,
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

export interface TeamDetailView extends TeamView {
  readonly viewerRole: 'owner' | 'admin' | 'member' | null;
}

/**
 * The team plus the viewer's own role in it.
 *
 * The client used to answer "what may I do here" by searching the member list it had already
 * fetched, which is wrong in a way that only shows up on large teams: that list is paginated and
 * sorted owner → admin → member, so an ordinary member of a 60-person team is not on the page the
 * client reads, and the UI offers them a Join button for a team they are already in. Membership is a
 * fact about the viewer, not something to infer from a page of other people.
 */
export function teamDetailView(
  t: import('@chess-platform/community').Team,
  viewerRole: 'owner' | 'admin' | 'member' | null
): TeamDetailView {
  return { ...teamView(t), viewerRole };
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

export interface AchievementDefinitionView {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly tier: 'bronze' | 'silver' | 'gold';
  readonly points: number;
  readonly hidden: boolean;
  readonly target?: number;
}

export function achievementDefinitionView(def: import('@chess-platform/achievements').AchievementDefinition): AchievementDefinitionView {
  return {
    key: def.key,
    name: def.name,
    description: def.description,
    category: def.category,
    tier: def.tier,
    points: def.points,
    hidden: def.hidden,
    ...(def.target !== undefined ? { target: def.target } : {}),
  };
}

export interface PlayerAchievementViewPresenter {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly tier: 'bronze' | 'silver' | 'gold';
  readonly points: number;
  readonly hidden: boolean;
  readonly target?: number;
  readonly progress: number;
  readonly unlockedAt: string | null;
}

export function playerAchievementView(item: import('@chess-platform/achievements').PlayerAchievementView): PlayerAchievementViewPresenter {
  return {
    key: item.key,
    name: item.name,
    description: item.description,
    category: item.category,
    tier: item.tier,
    points: item.points,
    hidden: item.hidden,
    ...(item.target !== undefined ? { target: item.target } : {}),
    progress: item.progress,
    unlockedAt: item.unlockedAt ? item.unlockedAt.toISOString() : null,
  };
}

export interface AchievementSummaryView {
  readonly unlockedCount: number;
  readonly pointsTotal: number;
}

export function achievementSummaryView(summary: import('@chess-platform/achievements').AchievementSummary): AchievementSummaryView {
  return {
    unlockedCount: summary.unlockedCount,
    pointsTotal: summary.pointsTotal,
  };
}

export interface StudyView {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly description: string;
  readonly visibility: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt?: string;
}

export function studyView(s: import('@chess-platform/studies').Study): StudyView {
  return {
    id: s.id,
    ownerId: s.ownerId,
    name: s.name,
    description: s.description,
    visibility: s.visibility,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    ...(s.deletedAt ? { deletedAt: s.deletedAt.toISOString() } : {}),
  };
}

export interface CollaboratorView {
  readonly studyId: string;
  readonly playerId: string;
  readonly role: string;
}

export function collaboratorView(c: import('@chess-platform/studies').Collaborator): CollaboratorView {
  return {
    studyId: c.studyId,
    playerId: c.playerId,
    role: c.role,
  };
}

export interface ChapterView {
  readonly id: string;
  readonly studyId: string;
  readonly name: string;
  readonly orderIndex: number;
  readonly startingFen: string;
  readonly deletedAt?: string;
}

export function chapterView(c: import('@chess-platform/studies').Chapter): ChapterView {
  return {
    id: c.id,
    studyId: c.studyId,
    name: c.name,
    orderIndex: c.orderIndex,
    startingFen: c.startingFen,
    ...(c.deletedAt ? { deletedAt: c.deletedAt.toISOString() } : {}),
  };
}

export interface TreeNodeView {
  readonly id: string;
  readonly chapterId: string;
  readonly parentId: string | null;
  readonly san: string;
  readonly fenAfter: string;
  readonly comment?: string;
  readonly nags: readonly number[];
  readonly orderIndex: number;
}

export function treeNodeView(n: import('@chess-platform/studies').TreeNode): TreeNodeView {
  return {
    id: n.id,
    chapterId: n.chapterId,
    parentId: n.parentId,
    san: n.san,
    fenAfter: n.fenAfter,
    ...(n.comment !== undefined ? { comment: n.comment } : {}),
    nags: [...n.nags],
    orderIndex: n.orderIndex,
  };
}

export interface ChapterDetailView {
  readonly chapter: ChapterView;
  readonly tree: readonly TreeNodeView[];
}

export function chapterDetailView(detail: {
  chapter: import('@chess-platform/studies').Chapter;
  tree: readonly import('@chess-platform/studies').TreeNode[];
}): ChapterDetailView {
  return {
    chapter: chapterView(detail.chapter),
    tree: detail.tree.map(treeNodeView),
  };
}

export interface CourseView {
  readonly id: string;
  readonly authorId: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly difficulty: string;
  readonly published: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt?: string;
}

export function courseView(c: import('@chess-platform/learning').Course): CourseView {
  return {
    id: c.id,
    authorId: c.authorId,
    slug: c.slug,
    title: c.title,
    description: c.description,
    difficulty: c.difficulty,
    published: c.published,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    ...(c.deletedAt ? { deletedAt: c.deletedAt.toISOString() } : {}),
  };
}

export interface LessonView {
  readonly id: string;
  readonly courseId: string;
  readonly title: string;
  readonly orderIndex: number;
  readonly deletedAt?: string;
}

export function lessonView(l: import('@chess-platform/learning').Lesson): LessonView {
  return {
    id: l.id,
    courseId: l.courseId,
    title: l.title,
    orderIndex: l.orderIndex,
    ...(l.deletedAt ? { deletedAt: l.deletedAt.toISOString() } : {}),
  };
}

export interface StepView {
  readonly id: string;
  readonly lessonId: string;
  readonly orderIndex: number;
  readonly kind: 'text' | 'move' | 'quiz';
  readonly prose?: string;
  readonly fen?: string;
  readonly expectedSan?: string;
  readonly hint?: string;
  readonly question?: string;
  readonly options?: readonly string[];
  readonly correctIndex?: number;
  readonly deletedAt?: string;
}

export function stepView(s: import('@chess-platform/learning').LessonStep): StepView {
  return {
    id: s.id,
    lessonId: s.lessonId,
    orderIndex: s.orderIndex,
    kind: s.kind,
    ...(s.kind === 'text' ? { prose: s.prose } : {}),
    ...(s.kind === 'move' ? { fen: s.fen, expectedSan: s.expectedSan, ...(s.hint ? { hint: s.hint } : {}) } : {}),
    ...(s.kind === 'quiz' ? { question: s.question, options: [...s.options], correctIndex: s.correctIndex } : {}),
    ...(s.deletedAt ? { deletedAt: s.deletedAt.toISOString() } : {}),
  };
}

export interface LearnerStepView {
  readonly id: string;
  readonly lessonId: string;
  readonly orderIndex: number;
  readonly kind: 'text' | 'move' | 'quiz';
  readonly prose?: string;
  readonly fen?: string;
  readonly hint?: string;
  readonly question?: string;
  readonly options?: readonly string[];
  readonly deletedAt?: string;
}

export function learnerStepView(s: import('@chess-platform/learning').LessonStep): LearnerStepView {
  return {
    id: s.id,
    lessonId: s.lessonId,
    orderIndex: s.orderIndex,
    kind: s.kind,
    ...(s.kind === 'text' ? { prose: s.prose } : {}),
    ...(s.kind === 'move' ? { fen: s.fen, ...(s.hint ? { hint: s.hint } : {}) } : {}),
    ...(s.kind === 'quiz' ? { question: s.question, options: [...s.options] } : {}),
    ...(s.deletedAt ? { deletedAt: s.deletedAt.toISOString() } : {}),
  };
}

export interface ProgressView {
  readonly playerId: string;
  readonly courseId: string;
  readonly lessonId: string;
  readonly stepId: string;
  readonly completedAt?: string;
  readonly attempts: number;
}

export function progressView(p: import('@chess-platform/learning').Progress): ProgressView {
  return {
    playerId: p.playerId,
    courseId: p.courseId,
    lessonId: p.lessonId,
    stepId: p.stepId,
    attempts: p.attempts,
    ...(p.completedAt ? { completedAt: p.completedAt.toISOString() } : {}),
  };
}

export interface CourseProgressSummaryView {
  readonly courseId: string;
  readonly playerId: string;
  readonly totalSteps: number;
  readonly completedSteps: number;
}

export function courseProgressSummaryView(
  s: import('@chess-platform/learning').CourseProgressSummary
): CourseProgressSummaryView {
  return {
    courseId: s.courseId,
    playerId: s.playerId,
    totalSteps: s.totalSteps,
    completedSteps: s.completedSteps,
  };
}

export interface AttemptResultView {
  readonly stepId: string;
  readonly correct: boolean;
  readonly completedAt?: string;
  readonly attempts: number;
}

export function attemptResultView(r: import('@chess-platform/learning').AttemptResult): AttemptResultView {
  return {
    stepId: r.stepId,
    correct: r.correct,
    attempts: r.attempts,
    ...(r.completedAt ? { completedAt: r.completedAt.toISOString() } : {}),
  };
}

export interface CapabilitiesFlags {
  readonly learning: boolean;
  readonly studies: boolean;
  readonly achievements: boolean;
  readonly search: boolean;
  readonly social: boolean;
  readonly messaging: boolean;
  readonly community: boolean;
  readonly analysis: boolean;
  /**
   * Engine-grounded move explanation (ADR-0115).
   *
   * Implies `analysis`, and cannot be true without it: an explanation is grounded in engine output,
   * so the composition root builds the feature only when both an AI provider and the analysis
   * subsystem are configured. The variants it can serve are therefore exactly `analysisVariants` —
   * a second list would be the same list, kept in a second place, free to drift.
   */
  readonly moveExplanation: boolean;
}

/**
 * The variants this deployment can actually analyse.
 *
 * The `analysis` flag alone is deployment-wide, and ADR-0113 registers only engines whose binary is
 * configured — so an image carrying Stockfish alone reports `analysis: true` while answering 422 for
 * Atomic, Crazyhouse, King of the Hill, Three-Check, Horde and Racing Kings. A client that knew only
 * the flag offered a control that could never work on six of the eight variants. Raised in the Qodo
 * review of PR #133 (ADR-0114 Decision 7).
 *
 * Answered without warming a pool: `EngineManager.supportsVariant` falls back to each registered
 * plugin's declared variants when cold (ADR-0102), so advertising this costs no engine process.
 *
 * Empty when analysis is off, so a client never has to read the flag and the list to know it cannot
 * analyse anything.
 */
export type AnalysisVariants = readonly string[];

export interface CapabilitiesView {
  readonly capabilities: CapabilitiesFlags;
  readonly analysisVariants: AnalysisVariants;
}

/**
 * What this deployment can actually serve, read off the dependencies it was built with.
 *
 * The parameter is the real `ApiDependencies`, not a structural type restating the seven property
 * names. Restating them compiles just as well and is a second copy of the configuration wearing a
 * disguise: rename `learningRepository` in `deps.ts` and a structural parameter keeps matching
 * nothing, so this reports `learning: false` forever, on a deployment that has learning switched
 * on, and no test fails. Naming the real type makes that rename a compile error.
 */
export function capabilitiesView(
  deps: Pick<
    import('./deps.js').ApiDependencies,
    | 'learningRepository'
    | 'studiesRepository'
    | 'achievementsRepository'
    | 'searchRepository'
    | 'socialGraphRepository'
    | 'messagingRepository'
    | 'communityRepository'
    | 'analysis'
    | 'moveExplanation'
  >,
): CapabilitiesView {
  return {
    capabilities: {
      learning: deps.learningRepository !== undefined,
      studies: deps.studiesRepository !== undefined,
      achievements: deps.achievementsRepository !== undefined,
      search: deps.searchRepository !== undefined,
      social: deps.socialGraphRepository !== undefined,
      messaging: deps.messagingRepository !== undefined,
      community: deps.communityRepository !== undefined,
      analysis: deps.analysis !== undefined,
      moveExplanation: deps.moveExplanation !== undefined,
    },
    analysisVariants: deps.analysis
      ? VARIANTS.filter((variant) => deps.analysis?.supportsVariant(variant) === true)
      : [],
  };
}

export interface AnalysisEvaluationView {
  readonly type: 'cp' | 'mate';
  readonly value: number;
}

export interface AnalysisLineView {
  readonly multipv: number;
  readonly evaluation: AnalysisEvaluationView;
  readonly moves: readonly string[];
  readonly depth: number;
  readonly nodes: number;
  readonly timeMs: number;
}

export interface AppliedAnalysisLimitsView {
  readonly depth: number;
  readonly movetimeMs: number;
  readonly multiPv: number;
  readonly nodes?: number;
}

export interface AnalysisResponseView {
  readonly fen: string;
  readonly variant: string;
  readonly applied: AppliedAnalysisLimitsView;
  readonly lines: readonly AnalysisLineView[];
}

export function analysisView(outcome: import('./analysis/service.js').AnalysisOutcome): AnalysisResponseView {
  return {
    fen: outcome.fen,
    variant: outcome.variant,
    applied: {
      depth: outcome.applied.depth,
      movetimeMs: outcome.applied.movetimeMs,
      multiPv: outcome.applied.multiPv,
      ...(outcome.applied.nodes !== undefined ? { nodes: outcome.applied.nodes } : {}),
    },
    lines: outcome.lines.map((line) => ({
      multipv: line.multipv,
      evaluation: {
        type: line.evaluation.type,
        value: line.evaluation.value,
      },
      moves: [...line.principalVariation],
      depth: line.depth,
      nodes: line.nodes,
      timeMs: line.timeMs,
    })),
  };
}

export interface MoveExplanationCitationView {
  readonly moveEvalKind: 'cp' | 'mate';
  readonly moveEvalValue: number;
  readonly moveEvalLabel: string;
  readonly evalKind: 'cp' | 'mate';
  readonly evalValue: number;
  readonly evalLabel: string;
  readonly bestMove: string | null;
  readonly bestLine: readonly string[];
  readonly depth: number;
}

export interface MoveExplanationView {
  readonly fen: string;
  readonly variant: string;
  readonly move: string;
  readonly explanation: string;
  readonly citation: MoveExplanationCitationView;
  readonly providerId: string;
  readonly model: string;
}

export function moveExplanationView(
  outcome: import('./ai/move-explanation-service.js').MoveExplanationOutcome,
): MoveExplanationView {
  return {
    fen: outcome.fen,
    variant: outcome.variant,
    move: outcome.move,
    explanation: outcome.explanation,
    citation: {
      moveEvalKind: outcome.citation.moveEvalKind,
      moveEvalValue: outcome.citation.moveEvalValue,
      moveEvalLabel: outcome.citation.moveEvalLabel,
      evalKind: outcome.citation.evalKind,
      evalValue: outcome.citation.evalValue,
      evalLabel: outcome.citation.evalLabel,
      bestMove: outcome.citation.bestMove,
      bestLine: [...outcome.citation.bestLine],
      depth: outcome.citation.depth,
    },
    providerId: outcome.providerId,
    model: outcome.model,
  };
}






