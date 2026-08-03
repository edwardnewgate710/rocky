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

