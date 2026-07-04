/**
 * @packageDocumentation
 * API configuration. Values are plain data with sane defaults; the only required
 * field is the access-token signing secret. {@link resolveConfig} fills defaults
 * and can read the secret from the environment for the bootstrap path.
 */

/** Fully-resolved API configuration. */
export interface ApiConfig {
  /** HMAC secret for access tokens (≥32 bytes). Never logged. */
  readonly accessTokenSecret: string;
  /** Access-token lifetime in seconds (default 15 minutes). */
  readonly accessTokenTtlSec: number;
  /** Refresh-token lifetime in seconds (default 30 days). */
  readonly refreshTokenTtlSec: number;
  /** Maximum accepted request body in bytes. */
  readonly maxBodyBytes: number;
  /** Trust `X-Forwarded-For` for client IP (enable only behind a trusted proxy). */
  readonly trustProxy: boolean;
}

export const DEFAULT_ACCESS_TOKEN_TTL_SEC = 15 * 60;
export const DEFAULT_REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;
export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

/** Partial config as accepted from callers. */
export type ApiConfigInput = Partial<ApiConfig>;

/**
 * Resolve a full {@link ApiConfig} from partial input, applying defaults. The
 * access-token secret falls back to `ACCESS_TOKEN_SECRET` in the environment.
 * Throws if no secret can be resolved.
 */
export function resolveConfig(input: ApiConfigInput = {}): ApiConfig {
  const accessTokenSecret = input.accessTokenSecret ?? process.env['ACCESS_TOKEN_SECRET'] ?? '';
  if (!accessTokenSecret) {
    throw new Error(
      'resolveConfig: accessTokenSecret is required (set it directly or via ACCESS_TOKEN_SECRET)',
    );
  }
  return {
    accessTokenSecret,
    accessTokenTtlSec: input.accessTokenTtlSec ?? DEFAULT_ACCESS_TOKEN_TTL_SEC,
    refreshTokenTtlSec: input.refreshTokenTtlSec ?? DEFAULT_REFRESH_TOKEN_TTL_SEC,
    maxBodyBytes: input.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    trustProxy: input.trustProxy ?? false,
  };
}
