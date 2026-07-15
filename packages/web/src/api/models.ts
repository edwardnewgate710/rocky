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
  readonly minRating: number | null;
  readonly maxRating: number | null;
  readonly createdAt: string;
}

export interface CreateSeekRequest {
  readonly variant: Variant;
  readonly timeControl: TimeControl;
  readonly rated?: boolean;
  readonly minRating?: number | null;
  readonly maxRating?: number | null;
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
