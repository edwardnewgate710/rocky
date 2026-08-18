/**
 * @packageDocumentation
 * API configuration. Values are plain data with safe defaults; the only required
 * field is the access-token signing secret. {@link resolveConfig} fills defaults
 * and can read the secret from the environment for the bootstrap path.
 */

import type { CorsConfig } from './http/security';

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
  /**
   * CORS policy. Safe default: no allowed origins (no cross-origin access).
   * Set `allowedOrigins` explicitly per deployment environment.
   *
   * @see docs/adr/0011-cors-security-headers.md
   */
  readonly cors: CorsConfig;
  /**
   * Emit `Strict-Transport-Security`. Disable in local/dev environments
   * where TLS is not terminated. Default: `true`.
   *
   * @see docs/adr/0011-cors-security-headers.md
   */
  readonly enableHsts: boolean;
  /**
   * Emit the `Secure` attribute on the refresh-token cookie. Default `true`.
   * Set `false` for local/dev over plain HTTP so the browser accepts the cookie.
   *
   * @see docs/adr/0012-httponly-refresh-cookie.md
   */
  readonly cookieSecure: boolean;
  /**
   * Rate limiting configuration for sensitive endpoints.
   */
  readonly rateLimit: RateLimitConfig;
  /**
   * WebAuthn / Passkeys configuration.
   */
  readonly webauthn: {
    readonly rpId: string;
    readonly origins: readonly string[];
  };
}

export interface RateLimitEndpointConfig {
  readonly maxRequests: number;
  readonly windowMs: number;
}

export interface RateLimitConfig {
  readonly enabled: boolean;
  readonly login: {
    readonly perIp: RateLimitEndpointConfig;
    readonly perHandle: RateLimitEndpointConfig;
  };
  readonly register: {
    readonly perIp: RateLimitEndpointConfig;
  };
  readonly refresh: {
    readonly perIp: RateLimitEndpointConfig;
  };
  readonly passwordResetRequest: {
    readonly perIp: RateLimitEndpointConfig;
    readonly perTarget: RateLimitEndpointConfig;
  };
  readonly webauthnLogin: {
    readonly perIp: RateLimitEndpointConfig;
    readonly perHandle: RateLimitEndpointConfig;
  };
  readonly webauthnRegister: {
    readonly perIp: RateLimitEndpointConfig;
  };
  readonly analysis: {
    readonly perUser: RateLimitEndpointConfig;
    readonly perIp: RateLimitEndpointConfig;
  };
  readonly moveExplanation: {
    readonly perUser: RateLimitEndpointConfig;
    readonly perIp: RateLimitEndpointConfig;
  };
  readonly mistakePrediction: {
    readonly perUser: RateLimitEndpointConfig;
    readonly perIp: RateLimitEndpointConfig;
  };
}

export const DEFAULT_ACCESS_TOKEN_TTL_SEC = 15 * 60;
export const DEFAULT_REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;
export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

/** The safe CORS default: no cross-origin access. */
export const DEFAULT_CORS: CorsConfig = {
  allowedOrigins: [],
  allowCredentials: false,
};

/** Default rate limiting configuration. */
export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  enabled: true,
  login: {
    perIp: { maxRequests: 10, windowMs: 5 * 60 * 1000 }, // 10 / 5 min
    perHandle: { maxRequests: 5, windowMs: 15 * 60 * 1000 }, // 5 / 15 min
  },
  register: {
    perIp: { maxRequests: 5, windowMs: 60 * 60 * 1000 }, // 5 / 60 min
  },
  refresh: {
    perIp: { maxRequests: 60, windowMs: 5 * 60 * 1000 }, // 60 / 5 min
  },
  passwordResetRequest: {
    perIp: { maxRequests: 5, windowMs: 60 * 60 * 1000 }, // 5 / 60 min
    perTarget: { maxRequests: 3, windowMs: 60 * 60 * 1000 }, // 3 / 60 min
  },
  webauthnLogin: {
    perIp: { maxRequests: 10, windowMs: 5 * 60 * 1000 }, // 10 / 5 min
    perHandle: { maxRequests: 5, windowMs: 15 * 60 * 1000 }, // 5 / 15 min
  },
  webauthnRegister: {
    perIp: { maxRequests: 5, windowMs: 60 * 60 * 1000 }, // 5 / 60 min
  },
  // Analysis is a CPU-amplification surface, so it is limited more tightly than a read endpoint.
  analysis: {
    perUser: { maxRequests: 30, windowMs: 60 * 1000 }, // 30 / min
    perIp: { maxRequests: 60, windowMs: 60 * 1000 }, // 60 / min
  },
  // Move explanation costs an engine search *and* a paid completion, so it is limited well below
  // analysis. The per-user limit is the one that matters: the per-IP limit is deliberately not a
  // multiple of it, because a shared NAT or a university network puts many legitimate accounts
  // behind one address, and an IP-only ceiling would ration them collectively.
  moveExplanation: {
    perUser: { maxRequests: 10, windowMs: 60 * 1000 }, // 10 / min
    perIp: { maxRequests: 30, windowMs: 60 * 1000 }, // 30 / min
  },
  // Mistake prediction costs up to two engine searches and no provider call, so it sits between the
  // two above: tighter than a single analysis because an accepted request can be two of them, and
  // looser than move explanation because there is no money in it. Its own bucket rather than a share
  // of the analysis one — a user assessing moves must not be able to exhaust their own ability to
  // analyse a position, and the two limits describe different costs.
  mistakePrediction: {
    perUser: { maxRequests: 20, windowMs: 60 * 1000 }, // 20 / min
    perIp: { maxRequests: 40, windowMs: 60 * 1000 }, // 40 / min
  },
};

/** Partial config as accepted from callers. */
export type ApiConfigInput = Partial<ApiConfig>;

/**
 * Enforce the {@link CorsConfig} invariants (see ADR-0011). The CORS middleware
 * reflects exact origins and never emits `*`, so a wildcard entry would silently
 * never match; and credentials without any allowed origin is a misconfiguration.
 * Failing fast here turns both footguns into a clear startup error.
 */
function validateCors(cors: CorsConfig): void {
  if (cors.allowedOrigins.includes('*')) {
    throw new Error(
      "resolveConfig: cors.allowedOrigins must not contain '*' — the API reflects " +
        "exact origins (never a wildcard). List explicit origins instead.",
    );
  }
  if (cors.allowCredentials && cors.allowedOrigins.length === 0) {
    throw new Error(
      'resolveConfig: cors.allowCredentials is true but cors.allowedOrigins is empty — ' +
        'no origin could ever use credentials. Add explicit origins or disable credentials.',
    );
  }
}

/**
 * Resolve a full {@link ApiConfig} from partial input, applying defaults. The
 * access-token secret falls back to `ACCESS_TOKEN_SECRET` in the environment.
 * Throws if no secret can be resolved or the CORS config is invalid.
 */
export function resolveConfig(input: ApiConfigInput = {}): ApiConfig {
  const accessTokenSecret = input.accessTokenSecret ?? process.env['ACCESS_TOKEN_SECRET'] ?? '';
  if (!accessTokenSecret) {
    throw new Error(
      'resolveConfig: accessTokenSecret is required (set it directly or via ACCESS_TOKEN_SECRET)',
    );
  }
  const cors = input.cors ?? DEFAULT_CORS;
  validateCors(cors);
  return {
    accessTokenSecret,
    accessTokenTtlSec: input.accessTokenTtlSec ?? DEFAULT_ACCESS_TOKEN_TTL_SEC,
    refreshTokenTtlSec: input.refreshTokenTtlSec ?? DEFAULT_REFRESH_TOKEN_TTL_SEC,
    maxBodyBytes: input.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    trustProxy: input.trustProxy ?? false,
    cors,
    enableHsts: input.enableHsts ?? true,
    cookieSecure: input.cookieSecure ?? true,
    rateLimit: input.rateLimit ?? DEFAULT_RATE_LIMIT,
    webauthn: input.webauthn ?? {
      rpId: process.env['WEBAUTHN_RP_ID'] ?? 'localhost',
      origins: (process.env['WEBAUTHN_ORIGINS'] ?? 'http://localhost:3000').split(','),
    },
  };
}
