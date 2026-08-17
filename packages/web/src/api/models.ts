/**
 * REST contract models — a hand-authored, framework-independent mirror of the
 * approved M4 API contract (`packages/api/openapi.json`).
 *
 * These are the request/response shapes the typed client (`api/client.ts`)
 * consumes. They are kept deliberately minimal and read-only. Fields the
 * contract marks `nullable` are `T | null` (always present, possibly null);
 * fields that are truly optional in the request body use `?`.
 *
 * Scope note (M6 increment 3A): only the endpoints the networking foundation
 * needs are modeled — health, auth/session, users/profile, ratings,
 * leaderboard and game summaries. Lobby/matchmaking (seeks) and live game
 * streaming (WS) land with their own increments and are intentionally absent.
 *
 * M12 inc 2: `refreshToken` in `TokenPair` is now optional for the browser
 * flow — the browser never reads or stores it (it lives in an httpOnly
 * cookie). Non-browser API clients still receive it in the JSON body.
 * `RefreshRequest` is kept for API-client compatibility but the browser
 * flow no longer sends the token in the body (it relies on the cookie).
 */

/** Supported chess variants (matches the server's `variant` enum). */
export const VARIANTS = [
  'standard',
  'chess960',
  'kingofthehill',
  'atomic',
  'crazyhouse',
  'threecheck',
  'horde',
  'racingkings',
] as const;
export type Variant = (typeof VARIANTS)[number];

/**
 * The variants the lobby offers, which is deliberately not the same list.
 *
 * `VARIANTS` mirrors what the server's enum accepts and must keep doing so — the API really does
 * take `chess960`, and a client that could not name it would be wrong about the contract. What a
 * player may *pick* is a separate question, and conflating the two is why a variant with no
 * implementation behind it was selectable for so long.
 *
 * `chess960` is withheld: `Position.initial('chess960')` returns the standard array rather than one
 * of the 960 arrangements, and castling is hardcoded to e1/a1/h1 in `packages/chess-core`, so it
 * only works from the one start position that is standard chess. Choosing it produced an ordinary
 * game wearing a different label. See ADR-0099; restore it here once the variant is real.
 *
 * Written out rather than derived as `VARIANTS.filter(v => v !== 'chess960')`. Subtracting from the
 * contract list makes offering the default and withholding the exception, so a variant added to
 * `VARIANTS` tomorrow becomes selectable the moment it is named — which is precisely how a variant
 * with nothing behind it came to be on the board in the first place. Naming what is offered means a
 * new variant has to be let in deliberately, and the test in `create-game-prefs.test.ts` fails until
 * someone does.
 */
export const OFFERED_VARIANTS: readonly Variant[] = [
  'standard',
  'kingofthehill',
  'atomic',
  'crazyhouse',
  'threecheck',
  'horde',
  'racingkings',
];

/**
 * A seek's color preference (matches the server's `color` enum). `random` (the
 * default) lets pairing assign sides; `white`/`black` request that side.
 */
export const SEEK_COLORS = ['white', 'black', 'random'] as const;
export type SeekColor = (typeof SEEK_COLORS)[number];

/** Account roles (matches the server's `role` enum). */
export const USER_ROLES = ['user', 'coach', 'tournament_director', 'moderator', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Access + refresh token pair returned by the auth endpoints.
 *
 * `refreshToken` is optional: the API still returns it in the JSON body for
 * non-browser API clients, but the browser flow (M12 inc 2) never reads or
 * stores it — the refresh token lives in an httpOnly cookie set by the API.
 */
export interface TokenPair {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  /** Access-token lifetime in seconds. */
  readonly expiresIn: number;
  /**
   * Opaque refresh token. Present for non-browser API clients; the browser
   * never reads this (it uses the httpOnly cookie). See ADR-0012.
   */
  readonly refreshToken?: string;
  /** ISO-8601 timestamp. */
  readonly refreshExpiresAt: string;
}

/** The authenticated user's own account view. */
export interface SelfUser {
  readonly id: string;
  readonly handle: string;
  readonly country: string | null;
  readonly createdAt: string;
  readonly roles: readonly UserRole[];
}

/** A public account view (no roles). */
export interface PublicUser {
  readonly id: string;
  readonly handle: string;
  readonly country: string | null;
  readonly createdAt: string;
}

export interface AuthResponse {
  readonly user: SelfUser;
  readonly tokens: TokenPair;
}

export interface RegisterRequest {
  readonly handle: string;
  readonly password: string;
  readonly email?: string | null;
}

export interface LoginRequest {
  readonly handle: string;
  readonly password: string;
}

export interface PasswordResetRequest {
  readonly handleOrEmail: string;
}

export interface PasswordResetConfirmRequest {
  readonly token: string;
  readonly newPassword: string;
}

export interface EmailVerifyRequest {
  readonly token: string;
}

/**
 * Refresh request body. Used by non-browser API clients that send the
 * refresh token in the JSON body. The browser flow omits the body and
 * relies on the httpOnly cookie (sent automatically with `credentials: 'include'`).
 */
export interface RefreshRequest {
  readonly refreshToken?: string;
}

/** A server-side session record (device/login). */
export interface SessionView {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly lastSeenAt: string | null;
  readonly lastIp: string | null;
  readonly lastUserAgent: string | null;
  readonly createdIp: string | null;
  readonly createdUserAgent: string | null;
}

/** A per-variant rating (Glicko-2 style fields). */
export interface RatingView {
  readonly variant: Variant;
  readonly rating: number;
  readonly rd: number;
  readonly vol: number;
  readonly updatedAt: string | null;
}

export interface UserProfile {
  readonly user: PublicUser;
  readonly ratings: readonly RatingView[];
}

export interface LeaderboardEntry {
  readonly userId: string;
  readonly variant: Variant;
  readonly rating: number;
  readonly rd: number;
}

export interface GameSummary {
  readonly id: string;
  readonly variant: Variant;
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

export interface Health {
  readonly status: 'ok';
  readonly name: string;
  readonly version: string;
}

export interface SystemCapabilities {
  readonly learning: boolean;
  readonly studies: boolean;
  readonly achievements: boolean;
  readonly search: boolean;
  readonly social: boolean;
  readonly messaging: boolean;
  readonly community: boolean;
  readonly analysis: boolean;
}

export interface CapabilitiesResponse {
  /**
   * Variants this deployment can analyse. The `analysis` flag is deployment-wide, but only engines
   * with a configured binary are registered server-side, so a deployment can report `analysis: true`
   * while serving a subset. Optional here because a server predating this field simply omits it.
   */
  readonly analysisVariants?: readonly string[];
  readonly capabilities: SystemCapabilities;
}

/** A seek (open game offer) in the lobby. */
export interface SeekView {
  readonly id: string;
  readonly creatorId: string;
  readonly variant: Variant;
  readonly speed: string;
  readonly timeControl: TimeControl;
  readonly rated: boolean;
  readonly color: SeekColor;
  readonly minRating: number | null;
  readonly maxRating: number | null;
  readonly createdAt: string;
  readonly gameId: string | null;
  readonly acceptedAt: string | null;
}

export interface CreateSeekRequest {
  readonly variant: Variant;
  readonly timeControl: TimeControl;
  readonly rated?: boolean;
  /** Creator's color preference. Defaults to `random` server-side when omitted. */
  readonly color?: SeekColor;
  readonly minRating?: number | null;
  readonly maxRating?: number | null;
}

/** Engine bot difficulty, matching the server's bot catalogue. */
export type BotLevel = 'novice' | 'club' | 'master';

export interface CreateBotGameRequest {
  readonly level: BotLevel;
  readonly variant: Variant;
  readonly timeControl: TimeControl;
  readonly color?: SeekColor;
}

/** Time control shape (mirrors the server's TimeControl schema). */
export interface TimeControl {
  readonly initialMs: number;
  readonly incrementMs: number;
  readonly delayMs: number;
  readonly kind: 'increment' | 'delay' | 'sudden_death' | 'unlimited';
}

/**
 * The wire shape of a server error body. Every non-2xx response the API returns
 * carries this envelope; the client parses it into a typed `HttpError`.
 */
export interface ApiErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly details?: Record<string, unknown>;
  };
}

// --- Social graph (M10) -----------------------------------------------------

/** A paginated list as the social endpoints return it: a total plus one page. */
export interface SocialPage<T> {
  readonly total: number;
  readonly items: readonly T[];
}

export interface FollowEdge {
  readonly followerId: string;
  readonly followeeId: string;
  readonly followedAt: string;
}

/**
 * The states a friend request can hold. `ended` is reachable only from
 * `accepted` (a friendship being terminated), which is why it appears in a
 * request's status rather than in a separate model — see ADR-0066.
 */
export type FriendRequestStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'ended';

/** The actions a caller may take on a request; the server decides which are legal. */
export type FriendRequestAction = 'accept' | 'decline' | 'cancel';

export interface FriendRequest {
  readonly id: string;
  readonly requesterId: string;
  readonly addresseeId: string;
  readonly status: FriendRequestStatus;
  readonly createdAt: string;
  readonly respondedAt: string | null;
}

export interface BlockEdge {
  readonly blockerId: string;
  readonly blockedId: string;
  readonly blockedAt: string;
}

/**
 * A player as the read layer names them. The social REST endpoints return bare
 * ids — there is no id-to-handle lookup in REST, only `player(id:)` in GraphQL
 * — so a display name is available exactly when the read layer is reachable.
 */
export interface SocialPlayer {
  readonly id: string;
  readonly handle: string;
}

/** Followers and following for one player, resolved to display names. */
export interface SocialConnections {
  readonly followers: SocialPage<SocialPlayer>;
  readonly following: SocialPage<SocialPlayer>;
}

// --- Tournaments (M14 inc 15) -----------------------------------------------

export type TournamentFormat = 'round_robin' | 'swiss' | 'arena';
export type TournamentState = 'registration' | 'running' | 'finished';

export interface TournamentSummary {
  readonly id: string;
  readonly name: string;
  readonly format: TournamentFormat;
  readonly state: TournamentState;
  readonly participantCount: number;
}

export interface ArenaTournamentDetail {
  readonly id: string;
  readonly name: string;
  readonly format: 'arena';
  readonly variant: Variant;
  readonly timeControl: TimeControl;
  readonly durationMs: number;
  readonly state: TournamentState;
  readonly participants: readonly string[];
  readonly startedAtMs?: number;
}

export interface SwissOrRoundRobinTournamentDetail {
  readonly id: string;
  readonly name: string;
  readonly format: 'swiss' | 'round_robin';
  readonly variant: Variant;
  readonly timeControl: TimeControl;
  readonly rounds?: number;
  readonly state: TournamentState;
  readonly participants: readonly string[];
  readonly roundsGenerated: number;
  readonly tiebreakOrder: readonly string[];
}

export type TournamentDetail = ArenaTournamentDetail | SwissOrRoundRobinTournamentDetail;

export interface ArenaStanding {
  readonly rank: number;
  readonly playerId: string;
  readonly points: number;
  readonly wins: number;
  readonly draws: number;
  readonly losses: number;
  readonly gamesPlayed: number;
  readonly onFire: boolean;
}

export interface SwissOrRoundRobinStanding {
  readonly rank: number;
  readonly playerId: string;
  readonly points: number;
  readonly tiebreak: number;
  readonly buchholz: number;
  readonly medianBuchholz: number;
  readonly withdrawn: boolean;
}

export type TournamentStanding = ArenaStanding | SwissOrRoundRobinStanding;

export interface TournamentLiveBoard {
  readonly gameId: string;
  readonly white: string;
  readonly black: string;
  readonly ply: number;
  readonly turn: 'w' | 'b';
  readonly fen: string;
  readonly fenHash: string;
  readonly clock: {
    readonly w: number;
    readonly b: number;
  };
  readonly status:
    | { readonly over: false }
    | {
        readonly over: true;
        readonly result: string;
        readonly termination: string;
        readonly winner: 'w' | 'b' | null;
      };
}

export interface TournamentLive {
  readonly games: readonly TournamentLiveBoard[];
  readonly standings: readonly TournamentStanding[];
}

// --- Search (M14 inc 16) ----------------------------------------------------

export type SearchMode = 'keyword' | 'semantic' | 'hybrid';

/**
 * Everything the row needs, carried on the hit itself.
 *
 * Optional because a document indexed before the field existed still matches and is still returned;
 * the UI falls back to the id rather than dropping the row.
 */
export interface SearchDisplay {
  readonly type: 'game' | 'player' | 'tournament';
  readonly title: string;
  readonly subtitle?: string;
}

export interface SearchResult {
  readonly id: string;
  readonly score: number;
  readonly display?: SearchDisplay;
}

export interface SearchResults {
  readonly total: number;
  readonly results: readonly SearchResult[];
}

// --- Direct Messaging (M14 inc 18) -------------------------------------------

export interface ConversationView {
  readonly id: string;
  readonly participantA: string;
  readonly participantB: string;
  readonly createdAt: string;
  readonly lastMessageAt: string;
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

export interface ConversationSummary {
  readonly conversation: ConversationView;
  readonly unreadCount: number;
  readonly lastMessage: MessageView | null;
}

export interface ConversationList {
  readonly total: number;
  readonly items: readonly ConversationSummary[];
}

export interface MessageList {
  readonly total: number;
  readonly items: readonly MessageView[];
}

export interface ConversationReadState {
  readonly conversationId: string;
  readonly participantId: string;
  readonly lastReadAt: string;
}

// --- Teams (M14 inc 20) --------------------------------------------------------

export interface TeamView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly visibility: 'public' | 'private';
  readonly createdBy: string;
  readonly createdAt: string;
}

/**
 * The team detail response. `viewerRole` is the viewer's own role, sent by the server because the
 * client cannot derive it: the member list is paginated and sorted owner → admin → member, so an
 * ordinary member of a large team is not on the page the client reads.
 */
export interface TeamDetailView extends TeamView {
  readonly viewerRole: 'owner' | 'admin' | 'member' | null;
}

export interface TeamList {
  readonly total: number;
  readonly items: readonly TeamView[];
}

export interface TeamMembership {
  readonly teamId: string;
  readonly playerId: string;
  readonly role: 'owner' | 'admin' | 'member';
  readonly joinedAt: string;
}

export interface TeamMemberList {
  readonly total: number;
  readonly items: readonly TeamMembership[];
}

export interface JoinRequestView {
  readonly id: string;
  readonly teamId: string;
  readonly playerId: string;
  readonly status: 'pending' | 'accepted' | 'declined' | 'cancelled';
  readonly createdAt: string;
  readonly respondedAt: string | null;
}

export interface JoinRequestList {
  readonly total: number;
  readonly items: readonly JoinRequestView[];
}

// --- Team forums (M14 inc 21) --------------------------------------------------

export interface ForumThread {
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

export interface ForumThreadList {
  readonly total: number;
  readonly items: readonly ForumThread[];
}

export interface ForumPost {
  readonly id: string;
  readonly threadId: string;
  readonly authorId: string;
  readonly body: string;
  readonly createdAt: string;
  readonly editedAt: string | null;
  readonly deletedAt: string | null;
}

export interface ForumPostList {
  readonly total: number;
  readonly items: readonly ForumPost[];
}

/** Creating a thread needs a title and an opening body, and returns both objects. */
export interface ForumThreadCreated {
  readonly thread: ForumThread;
  readonly firstPost: ForumPost;
}

// --- Achievements (M14 inc 22) ---------------------------------------------------

export type AchievementTier = 'bronze' | 'silver' | 'gold';

/**
 * One catalogue entry joined with this player's progress towards it.
 *
 * `target` is optional in the published contract and absent for one-shot achievements; the domain
 * reads an absent target as 1 (`packages/achievements/src/award.ts`), and so must anything here that
 * turns progress into a fraction.
 */
export interface PlayerAchievement {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly tier: AchievementTier;
  readonly points: number;
  readonly hidden: boolean;
  readonly target?: number;
  readonly progress: number;
  readonly unlockedAt: string | null;
}

export interface PlayerAchievementList {
  readonly total: number;
  readonly items: readonly PlayerAchievement[];
}

export interface AchievementSummary {
  readonly unlockedCount: number;
  readonly pointsTotal: number;
}

// --- Learning & Courses (M14 inc 23) -------------------------------------------

export type CourseDifficulty = 'beginner' | 'intermediate' | 'advanced';

export interface CourseView {
  readonly id: string;
  readonly authorId: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly difficulty: CourseDifficulty;
  readonly published: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt?: string;
}

export interface CourseList {
  readonly total: number;
  readonly items: readonly CourseView[];
}

export interface LessonView {
  readonly id: string;
  readonly courseId: string;
  readonly title: string;
  readonly orderIndex: number;
  readonly deletedAt?: string;
}

export interface TextStepView {
  readonly id: string;
  readonly lessonId: string;
  readonly orderIndex: number;
  readonly kind: 'text';
  readonly prose: string;
  readonly deletedAt?: string;
}

export interface MoveStepView {
  readonly id: string;
  readonly lessonId: string;
  readonly orderIndex: number;
  readonly kind: 'move';
  readonly fen: string;
  // expectedSan is omitted in the learner step view (ADR-0095) so the client cannot grade attempts locally
  readonly hint?: string;
  readonly deletedAt?: string;
}

export interface QuizStepView {
  readonly id: string;
  readonly lessonId: string;
  readonly orderIndex: number;
  readonly kind: 'quiz';
  readonly question: string;
  readonly options: readonly string[];
  // correctIndex is omitted in the learner step view (ADR-0095) so the client cannot grade attempts locally
  readonly deletedAt?: string;
}

export type StepView = TextStepView | MoveStepView | QuizStepView;

export interface CourseProgressSummaryView {
  readonly courseId: string;
  readonly playerId: string;
  readonly totalSteps: number;
  readonly completedSteps: number;
}

export interface ProgressView {
  readonly playerId: string;
  readonly courseId: string;
  readonly lessonId: string;
  readonly stepId: string;
  readonly completedAt?: string;
  readonly attempts: number;
}

export interface AttemptResultView {
  readonly stepId: string;
  readonly correct: boolean;
  readonly completedAt?: string;
  readonly attempts: number;
}

export interface SubmitAttemptRequest {
  readonly san?: string;
  readonly selectedIndex?: number;
}

// --- Studies (M14 inc 24) ------------------------------------------------------

export type StudyVisibility = 'public' | 'unlisted' | 'private';
export type StudyRole = 'owner' | 'contributor' | 'viewer';

export interface StudyView {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly description: string;
  readonly visibility: StudyVisibility;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt?: string;
}

export interface StudyList {
  readonly total: number;
  readonly items: readonly StudyView[];
}

export interface ChapterView {
  readonly id: string;
  readonly studyId: string;
  readonly name: string;
  readonly orderIndex: number;
  readonly startingFen: string;
  readonly deletedAt?: string;
}

export interface ChapterList {
  readonly items: readonly ChapterView[];
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

export interface ChapterDetailView {
  readonly chapter: ChapterView;
  readonly tree: readonly TreeNodeView[];
}

export interface CollaboratorView {
  readonly studyId: string;
  readonly playerId: string;
  readonly role: StudyRole;
}

export interface CollaboratorList {
  readonly items: readonly CollaboratorView[];
}

// --- WebAuthn / Passkeys (M14 inc 44) ---------------------------------------

export interface PasskeyView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastUsedAt?: string | null;
}

export interface WebAuthnRegisterOptions {
  readonly challenge: string;
  readonly rp: { readonly name: string; readonly id: string };
  readonly user: { readonly id: string; readonly name: string; readonly displayName: string };
  readonly pubKeyCredParams: readonly { readonly type: string; readonly alg: number }[];
  readonly timeout: number;
  readonly attestation: string;
  readonly authenticatorSelection: { readonly userVerification: string; readonly residentKey: string };
}

export interface WebAuthnRegisterVerifyRequest {
  readonly id: string;
  readonly rawId: string;
  readonly type: string;
  readonly response: {
    readonly clientDataJSON: string;
    readonly attestationObject: string;
  };
}

export interface WebAuthnLoginOptionsRequest {
  readonly handle: string;
}

export interface WebAuthnLoginOptions {
  readonly challenge: string;
  readonly timeout: number;
  readonly rpId: string;
  readonly userVerification: string;
  readonly allowCredentials?: readonly {
    readonly type: string;
    readonly id: string;
    readonly transports?: readonly string[];
  }[];
}

export interface WebAuthnLoginVerifyRequest {
  readonly id: string;
  readonly rawId: string;
  readonly type: string;
  readonly response: {
    readonly clientDataJSON: string;
    readonly authenticatorData: string;
    readonly signature: string;
    readonly userHandle?: string;
  };
}

// --- Engine Analysis (M15 inc 2) -------------------------------------------

export interface AnalysisEvaluation {
  readonly type: 'cp' | 'mate';
  readonly value: number;
}

export interface AnalysisLine {
  readonly multipv: number;
  readonly evaluation: AnalysisEvaluation;
  readonly moves: readonly string[];
  readonly depth: number;
  readonly nodes: number;
  readonly timeMs: number;
}

export interface AppliedAnalysisLimits {
  readonly depth: number;
  readonly movetimeMs: number;
  readonly multiPv: number;
  readonly nodes?: number;
}

export interface AnalysisResponse {
  readonly fen: string;
  readonly variant: string;
  readonly applied: AppliedAnalysisLimits;
  readonly lines: readonly AnalysisLine[];
}

export interface AnalyzeRequest {
  readonly fen: string;
  readonly variant: string;
  readonly depth?: number;
  readonly nodes?: number;
  readonly movetimeMs?: number;
  readonly multiPv?: number;
}
