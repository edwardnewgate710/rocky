/**
 * @packageDocumentation
 * Reusable OpenAPI component schemas describing every request and response body.
 * These are the single source of truth for the wire contract; the presenters
 * emit exactly these shapes and the spec builder references them by name.
 */

import { ROLES, SEEK_COLORS, TIME_CONTROL_KINDS, VARIANTS } from '../domain';
import { DEFAULT_ANALYSIS_LIMITS } from '../analysis/limits';
import type { ComponentSchemas, JsonSchema } from './types';

const dateTime: JsonSchema = { type: 'string', format: 'date-time' };
const nullableString: JsonSchema = { type: 'string', nullable: true };

/**
 * The terminal vocabulary, kept in one place because two schemas publish it.
 *
 * Mirrors `TerminalReason` in `analysis/terminal.ts`, which in turn mirrors core's `GameStatus`
 * reasons; `RESULT_STRINGS` is the platform's existing `ResultString`.
 */
const TERMINAL_REASONS = [
  'checkmate',
  'stalemate',
  'insufficient_material',
  'fifty_move',
  'threefold',
  'variant_win',
  'variant_draw',
] as const;
const RESULT_STRINGS = ['1-0', '0-1', '1/2-1/2'] as const;

/** Shared shape for a decided position's outcome. */
const terminalOutcomeSchema: JsonSchema = {
  type: 'object',
  required: ['reason', 'result'],
  properties: {
    reason: { type: 'string', enum: [...TERMINAL_REASONS] },
    result: { type: 'string', enum: [...RESULT_STRINGS] },
  },
  additionalProperties: false,
};
const nullableInt: JsonSchema = { type: 'integer', nullable: true };

const timeControl: JsonSchema = {
  type: 'object',
  description: 'Chess time control. All durations are in milliseconds.',
  required: ['initialMs', 'incrementMs', 'delayMs', 'kind'],
  properties: {
    initialMs: { type: 'integer', minimum: 0, description: 'Base thinking time per side.' },
    incrementMs: { type: 'integer', minimum: 0, description: 'Fischer increment per move.' },
    delayMs: { type: 'integer', minimum: 0, description: 'Bronstein/US delay per move.' },
    kind: { type: 'string', enum: [...TIME_CONTROL_KINDS] },
  },
  additionalProperties: false,
};

export const COMPONENT_SCHEMAS: ComponentSchemas = {
  Error: {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message', 'requestId'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          requestId: { type: 'string' },
          details: { type: 'object', additionalProperties: true },
        },
      },
    },
  },

  TimeControl: timeControl,

  TokenPair: {
    type: 'object',
    required: ['accessToken', 'tokenType', 'expiresIn', 'refreshToken', 'refreshExpiresAt'],
    properties: {
      accessToken: { type: 'string', description: 'HMAC-SHA256 (HS256) bearer token.' },
      tokenType: { type: 'string', enum: ['Bearer'] },
      expiresIn: { type: 'integer', description: 'Access-token lifetime in seconds.' },
      refreshToken: { type: 'string', description: 'Opaque, single-use refresh token. Also set as an httpOnly cookie for browser clients; non-browser API clients read it from the response body.' },
      refreshExpiresAt: dateTime,
    },
  },

  PublicUser: {
    type: 'object',
    required: ['id', 'handle', 'country', 'createdAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      handle: { type: 'string' },
      country: nullableString,
      createdAt: dateTime,
    },
  },

  SelfUser: {
    type: 'object',
    required: ['id', 'handle', 'country', 'createdAt', 'roles'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      handle: { type: 'string' },
      country: nullableString,
      createdAt: dateTime,
      roles: { type: 'array', items: { type: 'string', enum: [...ROLES] } },
    },
  },

  RatingView: {
    type: 'object',
    required: ['variant', 'rating', 'rd', 'vol', 'updatedAt'],
    properties: {
      variant: { type: 'string', enum: [...VARIANTS] },
      rating: { type: 'number' },
      rd: { type: 'number' },
      vol: { type: 'number' },
      updatedAt: { ...dateTime, nullable: true },
    },
  },

  LeaderboardEntry: {
    type: 'object',
    required: ['userId', 'variant', 'rating', 'rd'],
    properties: {
      userId: { type: 'string', format: 'uuid' },
      variant: { type: 'string', enum: [...VARIANTS] },
      rating: { type: 'number' },
      rd: { type: 'number' },
    },
  },

  SessionView: {
    type: 'object',
    required: [
      'id',
      'createdAt',
      'expiresAt',
      'revokedAt',
      'lastSeenAt',
      'lastIp',
      'lastUserAgent',
      'createdIp',
      'createdUserAgent',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      createdAt: dateTime,
      expiresAt: dateTime,
      revokedAt: { ...dateTime, nullable: true },
      lastSeenAt: { ...dateTime, nullable: true },
      lastIp: nullableString,
      lastUserAgent: nullableString,
      createdIp: nullableString,
      createdUserAgent: nullableString,
    },
  },

  SeekView: {
    type: 'object',
    required: [
      'id',
      'creatorId',
      'variant',
      'speed',
      'timeControl',
      'rated',
      'color',
      'minRating',
      'maxRating',
      'createdAt',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      creatorId: { type: 'string', format: 'uuid' },
      variant: { type: 'string', enum: [...VARIANTS] },
      speed: { type: 'string' },
      timeControl: { $ref: '#/components/schemas/TimeControl' },
      rated: { type: 'boolean' },
      color: { type: 'string', enum: [...SEEK_COLORS] },
      minRating: nullableInt,
      maxRating: nullableInt,
      createdAt: dateTime,
      gameId: nullableString,
      acceptedAt: { ...dateTime, nullable: true },
    },
  },

  GameSummary: {
    type: 'object',
    required: [
      'id',
      'variant',
      'rated',
      'speed',
      'whiteId',
      'blackId',
      'result',
      'termination',
      'plyCount',
      'startedAt',
      'endedAt',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      variant: { type: 'string', enum: [...VARIANTS] },
      rated: { type: 'boolean' },
      speed: { type: 'string' },
      whiteId: { type: 'string', format: 'uuid', nullable: true },
      blackId: { type: 'string', format: 'uuid', nullable: true },
      result: nullableString,
      termination: nullableString,
      plyCount: { type: 'integer' },
      startedAt: dateTime,
      endedAt: { ...dateTime, nullable: true },
    },
  },

  Health: {
    type: 'object',
    required: ['status', 'name', 'version'],
    properties: {
      status: { type: 'string', enum: ['ok'] },
      name: { type: 'string' },
      version: { type: 'string' },
    },
  },

  Capabilities: {
    type: 'object',
    required: ['capabilities', 'analysisVariants'],
    properties: {
      // The `analysis` flag is deployment-wide, but only engines with a configured binary are
      // registered (ADR-0113), so a deployment can report `analysis: true` while serving a subset of
      // variants. A client that read only the flag would offer a control that answers 422 on every
      // other variant, which is what this list exists to prevent. Empty when analysis is off.
      analysisVariants: {
        type: 'array',
        items: { type: 'string', enum: [...VARIANTS] },
      },
      capabilities: {
        type: 'object',
        required: ['learning', 'studies', 'achievements', 'search', 'social', 'messaging', 'community', 'analysis', 'moveExplanation'],
        properties: {
          learning: { type: 'boolean' },
          studies: { type: 'boolean' },
          achievements: { type: 'boolean' },
          search: { type: 'boolean' },
          social: { type: 'boolean' },
          messaging: { type: 'boolean' },
          community: { type: 'boolean' },
          analysis: { type: 'boolean' },
          moveExplanation: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },

  UserProfile: {
    type: 'object',
    required: ['user', 'ratings'],
    properties: {
      user: { $ref: '#/components/schemas/PublicUser' },
      ratings: { type: 'array', items: { $ref: '#/components/schemas/RatingView' } },
    },
  },

  RatingList: { type: 'array', items: { $ref: '#/components/schemas/RatingView' } },
  SessionList: { type: 'array', items: { $ref: '#/components/schemas/SessionView' } },
  SeekList: { type: 'array', items: { $ref: '#/components/schemas/SeekView' } },
  LeaderboardList: { type: 'array', items: { $ref: '#/components/schemas/LeaderboardEntry' } },
  GameList: { type: 'array', items: { $ref: '#/components/schemas/GameSummary' } },

  TournamentView: {
    type: 'object',
    required: ['id', 'name', 'format', 'variant', 'timeControl', 'state', 'participants', 'roundsGenerated'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      format: { type: 'string', enum: ['round_robin', 'swiss'] },
      variant: { type: 'string', enum: [...VARIANTS] },
      timeControl: { $ref: '#/components/schemas/TimeControl' },
      rounds: { type: 'integer' },
      state: { type: 'string', enum: ['registration', 'running', 'finished'] },
      participants: { type: 'array', items: { type: 'string', format: 'uuid' } },
      roundsGenerated: { type: 'integer' },
      tiebreakOrder: { type: 'array', items: { type: 'string', enum: ['sonneborn_berger', 'buchholz', 'median_buchholz'] } },
    },
  },

  ArenaTournamentView: {
    type: 'object',
    required: ['id', 'name', 'format', 'variant', 'timeControl', 'state', 'participants', 'durationMs'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      format: { type: 'string', enum: ['arena'] },
      variant: { type: 'string', enum: [...VARIANTS] },
      timeControl: { $ref: '#/components/schemas/TimeControl' },
      durationMs: { type: 'integer' },
      state: { type: 'string', enum: ['registration', 'running', 'finished'] },
      participants: { type: 'array', items: { type: 'string', format: 'uuid' } },
      startedAtMs: { type: 'integer' },
    },
  },

  TournamentSummaryView: {
    type: 'object',
    required: ['id', 'name', 'format', 'state', 'participantCount'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      format: { type: 'string', enum: ['round_robin', 'swiss', 'arena'] },
      state: { type: 'string', enum: ['registration', 'running', 'finished'] },
      participantCount: { type: 'integer' },
    },
  },

  TournamentAnyView: {
    oneOf: [
      { $ref: '#/components/schemas/TournamentView' },
      { $ref: '#/components/schemas/ArenaTournamentView' }
    ]
  },

  RoundView: {
    type: 'object',
    required: ['roundIndex', 'pairings'],
    properties: {
      roundIndex: { type: 'integer' },
      pairings: {
        type: 'array',
        items: {
          type: 'object',
          required: ['kind'],
          properties: {
            kind: { type: 'string', enum: ['game', 'bye'] },
            white: { type: 'string', format: 'uuid' },
            black: { type: 'string', format: 'uuid' },
            gameId: { type: 'string', format: 'uuid', nullable: true },
            player: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
  },

  PlayerStandingView: {
    type: 'object',
    required: ['rank', 'playerId', 'points', 'tiebreak', 'buchholz', 'medianBuchholz', 'withdrawn'],
    properties: {
      rank: { type: 'integer' },
      playerId: { type: 'string', format: 'uuid' },
      points: { type: 'number' },
      tiebreak: { type: 'number' },
      buchholz: { type: 'number' },
      medianBuchholz: { type: 'number' },
      withdrawn: { type: 'boolean' },
    },
  },

  ArenaStandingView: {
    type: 'object',
    required: ['rank', 'playerId', 'points', 'wins', 'draws', 'losses', 'gamesPlayed', 'onFire'],
    properties: {
      rank: { type: 'integer' },
      playerId: { type: 'string', format: 'uuid' },
      points: { type: 'integer' },
      wins: { type: 'integer' },
      draws: { type: 'integer' },
      losses: { type: 'integer' },
      gamesPlayed: { type: 'integer' },
      onFire: { type: 'boolean' },
    },
  },

  TournamentSummaryList: { type: 'array', items: { $ref: '#/components/schemas/TournamentSummaryView' } },
  RoundList: { type: 'array', items: { $ref: '#/components/schemas/RoundView' } },
  StandingList: { type: 'array', items: { $ref: '#/components/schemas/PlayerStandingView' } },
  ArenaStandingList: { type: 'array', items: { $ref: '#/components/schemas/ArenaStandingView' } },

  StandingAnyList: {
    oneOf: [
      { $ref: '#/components/schemas/StandingList' },
      { $ref: '#/components/schemas/ArenaStandingList' }
    ]
  },

  LiveBoard: {
    type: 'object',
    required: ['gameId', 'white', 'black', 'ply', 'turn', 'fen', 'fenHash', 'clock', 'status'],
    properties: {
      gameId: { type: 'string', format: 'uuid' },
      white: { type: 'string', format: 'uuid' },
      black: { type: 'string', format: 'uuid' },
      ply: { type: 'integer' },
      turn: { type: 'string', enum: ['w', 'b'] },
      fen: { type: 'string' },
      fenHash: { type: 'string' },
      clock: {
        type: 'object',
        required: ['w', 'b'],
        properties: {
          w: { type: 'integer' },
          b: { type: 'integer' },
        },
      },
      status: {
        type: 'object',
        required: ['over'],
        properties: {
          over: { type: 'boolean' },
          result: { type: 'string', nullable: true },
          termination: { type: 'string', nullable: true },
          winner: { type: 'string', enum: ['w', 'b'], nullable: true },
        },
      },
    },
  },

  TournamentLiveResponse: {
    type: 'object',
    required: ['games', 'standings'],
    properties: {
      games: { type: 'array', items: { $ref: '#/components/schemas/LiveBoard' } },
      standings: { $ref: '#/components/schemas/StandingAnyList' },
    },
  },

  // --- Request bodies ---
  RegisterRequest: {
    type: 'object',
    required: ['handle', 'password'],
    properties: {
      handle: { type: 'string', minLength: 3, maxLength: 30, description: 'Alphanumeric, _ and -.' },
      password: { type: 'string', minLength: 8, maxLength: 1024 },
      email: { type: 'string', format: 'email', nullable: true },
    },
    additionalProperties: false,
  },

  LoginRequest: {
    type: 'object',
    required: ['handle', 'password'],
    properties: {
      handle: { type: 'string' },
      password: { type: 'string' },
    },
    additionalProperties: false,
  },

  RefreshRequest: {
    type: 'object',
    description: 'Refresh token request. The refresh token may be provided in the JSON body (non-browser API clients) or via the httpOnly `gambit_refresh` cookie (browser flow). The cookie is preferred when both are present.',
    properties: { refreshToken: { type: 'string', description: 'Opaque refresh token. Optional — may be provided via the httpOnly cookie instead.' } },
    additionalProperties: false,
  },

  AuthResponse: {
    type: 'object',
    required: ['user', 'tokens'],
    properties: {
      user: { $ref: '#/components/schemas/SelfUser' },
      tokens: { $ref: '#/components/schemas/TokenPair' },
    },
  },

  CreateSeekRequest: {
    type: 'object',
    required: ['variant', 'timeControl'],
    properties: {
      variant: { type: 'string', enum: [...VARIANTS] },
      timeControl: { $ref: '#/components/schemas/TimeControl' },
      rated: { type: 'boolean', description: 'Defaults to true.' },
      color: {
        type: 'string',
        enum: [...SEEK_COLORS],
        description: "Creator's color preference. Defaults to 'random'.",
      },
      minRating: { type: 'integer', nullable: true },
      maxRating: { type: 'integer', nullable: true },
    },
    additionalProperties: false,
  },

  CreateBotGameRequest: {
    type: 'object',
    required: ['level', 'variant', 'timeControl'],
    properties: {
      level: { type: 'string', enum: ['novice', 'club', 'master'], description: 'Engine bot strength level.' },
      variant: { type: 'string', enum: [...VARIANTS] },
      timeControl: { $ref: '#/components/schemas/TimeControl' },
      color: {
        type: 'string',
        enum: [...SEEK_COLORS],
        description: "Human player's color preference. Defaults to 'random'.",
      },
    },
    additionalProperties: false,
  },

  GrantRoleRequest: {
    type: 'object',
    required: ['role'],
    properties: { role: { type: 'string', enum: [...ROLES] } },
    additionalProperties: false,
  },

  CreateTournamentRequest: {
    type: 'object',
    required: ['name', 'format', 'variant', 'timeControl'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 50 },
      format: { type: 'string', enum: ['round_robin', 'swiss', 'arena'] },
      variant: { type: 'string', enum: [...VARIANTS] },
      timeControl: { $ref: '#/components/schemas/TimeControl' },
      rounds: { type: 'integer', minimum: 1, description: 'Required for swiss' },
      durationMs: { type: 'integer', minimum: 1, description: 'Required for arena' },
      tiebreakOrder: { type: 'array', items: { type: 'string', enum: ['sonneborn_berger', 'buchholz', 'median_buchholz'] }, description: 'Optional order for round-based formats' },
    },
    additionalProperties: false,
  },

  RegisterParticipantRequest: {
    type: 'object',
    properties: {
      playerId: { type: 'string', format: 'uuid' },
    },
    additionalProperties: false,
  },

  RecordResultRequest: {
    type: 'object',
    required: ['pairingIndex', 'result'],
    properties: {
      pairingIndex: { type: 'integer' },
      result: { type: 'string', enum: ['white_win', 'black_win', 'draw'] },
    },
    additionalProperties: false,
  },

  RecordResultByGameRequest: {
    type: 'object',
    required: ['result'],
    properties: {
      result: { type: 'string', enum: ['white_win', 'black_win', 'draw'] },
    },
    additionalProperties: false,
  },

  PasswordResetRequest: {
    type: 'object',
    required: ['handleOrEmail'],
    properties: {
      handleOrEmail: { type: 'string' },
    },
    additionalProperties: false,
  },

  PasswordResetConfirmRequest: {
    type: 'object',
    required: ['token', 'newPassword'],
    properties: {
      token: { type: 'string' },
      newPassword: { type: 'string', minLength: 8, maxLength: 1024 },
    },
    additionalProperties: false,
  },

  EmailVerifyRequest: {
    type: 'object',
    required: ['token'],
    properties: {
      token: { type: 'string' },
    },
    additionalProperties: false,
  },

  // --- WebAuthn / Passkeys ---
  PasskeyView: {
    type: 'object',
    required: ['id', 'name', 'createdAt'],
    properties: {
      id: { type: 'string', description: 'Base64URL encoded credential ID' },
      name: { type: 'string' },
      createdAt: dateTime,
      lastUsedAt: { ...dateTime, nullable: true },
    },
  },

  PasskeyList: { type: 'array', items: { $ref: '#/components/schemas/PasskeyView' } },

  WebAuthnRegisterOptions: {
    type: 'object',
    required: ['challenge', 'rp', 'user', 'pubKeyCredParams', 'timeout', 'attestation', 'authenticatorSelection'],
    properties: {
      challenge: { type: 'string' }, // Base64URL
      rp: { type: 'object', required: ['name', 'id'], properties: { name: { type: 'string' }, id: { type: 'string' } } },
      user: { type: 'object', required: ['id', 'name', 'displayName'], properties: { id: { type: 'string' }, name: { type: 'string' }, displayName: { type: 'string' } } },
      pubKeyCredParams: { type: 'array', items: { type: 'object', required: ['type', 'alg'], properties: { type: { type: 'string' }, alg: { type: 'integer' } } } },
      timeout: { type: 'integer' },
      attestation: { type: 'string' },
      authenticatorSelection: { type: 'object', properties: { userVerification: { type: 'string' }, residentKey: { type: 'string' } } },
    },
  },

  WebAuthnRegisterVerifyRequest: {
    type: 'object',
    required: ['id', 'rawId', 'type', 'response'],
    properties: {
      id: { type: 'string' },
      rawId: { type: 'string' },
      type: { type: 'string' },
      response: {
        type: 'object',
        required: ['clientDataJSON', 'attestationObject'],
        properties: {
          clientDataJSON: { type: 'string' },
          attestationObject: { type: 'string' },
        },
      },
    },
  },

  WebAuthnLoginOptionsRequest: {
    type: 'object',
    required: ['handle'],
    properties: { handle: { type: 'string' } },
    additionalProperties: false,
  },

  WebAuthnLoginOptions: {
    type: 'object',
    required: ['challenge', 'timeout', 'rpId', 'userVerification'],
    properties: {
      challenge: { type: 'string' },
      timeout: { type: 'integer' },
      rpId: { type: 'string' },
      allowCredentials: {
        type: 'array',
        items: {
          type: 'object',
          required: ['type', 'id'],
          properties: { type: { type: 'string' }, id: { type: 'string' }, transports: { type: 'array', items: { type: 'string' } } },
        },
      },
      userVerification: { type: 'string' },
    },
  },

  WebAuthnLoginVerifyRequest: {
    type: 'object',
    required: ['id', 'rawId', 'type', 'response'],
    properties: {
      id: { type: 'string' },
      rawId: { type: 'string' },
      type: { type: 'string' },
      response: {
        type: 'object',
        required: ['clientDataJSON', 'authenticatorData', 'signature'],
        properties: {
          clientDataJSON: { type: 'string' },
          authenticatorData: { type: 'string' },
          signature: { type: 'string' },
          userHandle: { type: 'string' },
        },
      },
    },
  },

  AntiCheatPlayerReport: {
    type: 'object',
    required: [
      'suspicion',
      'acpl',
      'acplCapped',
      't1Rate',
      't3Rate',
      'onlyMoveExcluded',
      'sampleSize',
      'unscored',
      'lowConfidence',
      't1Matches',
      't3Matches',
      'tRateSampleCount',
      'rawCentipawnLossTotal',
      'cappedCentipawnLossTotal',
    ],
    properties: {
      suspicion: { type: 'string', enum: ['clean', 'review', 'high'] },
      acpl: { type: 'number' },
      acplCapped: { type: 'number' },
      t1Rate: { type: 'number' },
      t3Rate: { type: 'number' },
      onlyMoveExcluded: { type: 'integer' },
      sampleSize: { type: 'integer' },
      unscored: { type: 'integer' },
      lowConfidence: { type: 'boolean' },
      t1Matches: { type: 'integer' },
      t3Matches: { type: 'integer' },
      tRateSampleCount: { type: 'integer' },
      rawCentipawnLossTotal: { type: 'number' },
      cappedCentipawnLossTotal: { type: 'number' },
    },
  },

  AntiCheatGameReportView: {
    type: 'object',
    required: ['gameId', 'playerId', 'color', 'report'],
    properties: {
      gameId: { type: 'string', format: 'uuid' },
      playerId: { type: 'string', format: 'uuid' },
      color: { type: 'string', enum: ['white', 'black'] },
      report: { $ref: '#/components/schemas/AntiCheatPlayerReport' },
    },
  },

  AntiCheatAggregateView: {
    type: 'object',
    required: [
      'playerId',
      'suspicion',
      'gamesAnalyzed',
      'pooledSampleSize',
      'pooledTRateSampleCount',
      'acpl',
      'acplCapped',
      't1Rate',
      't3Rate',
      'lowConfidence',
      'flaggedGameIds',
    ],
    properties: {
      playerId: { type: 'string', format: 'uuid' },
      suspicion: { type: 'string', enum: ['clean', 'review', 'high'] },
      gamesAnalyzed: { type: 'integer' },
      pooledSampleSize: { type: 'integer' },
      pooledTRateSampleCount: { type: 'integer' },
      acpl: { type: 'number' },
      acplCapped: { type: 'number' },
      t1Rate: { type: 'number' },
      t3Rate: { type: 'number' },
      lowConfidence: { type: 'boolean' },
      flaggedGameIds: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
      },
    },
  },

  AntiCheatGameReportList: {
    type: 'array',
    items: { $ref: '#/components/schemas/AntiCheatGameReportView' },
  },

  AnalyzeGameRequest: {
    type: 'object',
    properties: {
      depth: { type: 'integer', minimum: 8, maximum: 30 },
    },
    additionalProperties: false,
  },

  AntiCheatGameAnalysisView: {
    type: 'object',
    required: ['white', 'black'],
    properties: {
      white: { $ref: '#/components/schemas/AntiCheatPlayerReport' },
      black: { $ref: '#/components/schemas/AntiCheatPlayerReport' },
    },
  },

  BotBehaviorReportView: {
    type: 'object',
    required: [
      'suspicion',
      'sampleSize',
      'meanMs',
      'stdevMs',
      'coefficientOfVariation',
      'instantMoves',
      'instantFraction',
      'sumMs',
      'sumSqMs',
      'lowConfidence',
    ],
    properties: {
      suspicion: { type: 'string', enum: ['clean', 'review', 'high'] },
      sampleSize: { type: 'integer' },
      meanMs: { type: 'number' },
      stdevMs: { type: 'number' },
      coefficientOfVariation: { type: 'number' },
      instantMoves: { type: 'integer' },
      instantFraction: { type: 'number' },
      sumMs: { type: 'number' },
      sumSqMs: { type: 'number' },
      lowConfidence: { type: 'boolean' },
    },
  },

  BotGameReportView: {
    type: 'object',
    required: ['gameId', 'playerId', 'color', 'report'],
    properties: {
      gameId: { type: 'string', format: 'uuid' },
      playerId: { type: 'string', format: 'uuid' },
      color: { type: 'string', enum: ['white', 'black'] },
      report: { $ref: '#/components/schemas/BotBehaviorReportView' },
    },
  },

  BotAggregateView: {
    type: 'object',
    required: [
      'playerId',
      'suspicion',
      'gamesAnalyzed',
      'pooledSampleSize',
      'pooledMeanMs',
      'pooledStdevMs',
      'pooledCoefficientOfVariation',
      'pooledInstantMoves',
      'pooledInstantFraction',
      'lowConfidence',
      'flaggedGameIds',
    ],
    properties: {
      playerId: { type: 'string', format: 'uuid' },
      suspicion: { type: 'string', enum: ['clean', 'review', 'high'] },
      gamesAnalyzed: { type: 'integer' },
      pooledSampleSize: { type: 'integer' },
      pooledMeanMs: { type: 'number' },
      pooledStdevMs: { type: 'number' },
      pooledCoefficientOfVariation: { type: 'number' },
      pooledInstantMoves: { type: 'integer' },
      pooledInstantFraction: { type: 'number' },
      lowConfidence: { type: 'boolean' },
      flaggedGameIds: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
      },
    },
  },

  BotGameReportList: {
    type: 'array',
    items: { $ref: '#/components/schemas/BotGameReportView' },
  },

  BotGameAnalysisView: {
    type: 'object',
    required: ['white', 'black'],
    properties: {
      white: { $ref: '#/components/schemas/BotBehaviorReportView' },
      black: { $ref: '#/components/schemas/BotBehaviorReportView' },
    },
  },

  SearchDisplay: {
    type: 'object',
    description:
      'What a client needs to render the hit without fetching the entity again. Built only from ' +
      'data the entity’s own public view already exposes.',
    required: ['type', 'title'],
    properties: {
      type: { type: 'string', enum: ['game', 'player', 'tournament'] },
      title: { type: 'string' },
      subtitle: { type: 'string' },
    },
  },

  SearchResult: {
    type: 'object',
    // `display` is optional, not required: a document indexed before this field existed still
    // matches and must still be returned. Declaring it required would make the spec claim
    // something the server cannot promise for older rows.
    required: ['id', 'score'],
    properties: {
      id: { type: 'string' },
      score: { type: 'number' },
      display: { $ref: '#/components/schemas/SearchDisplay' },
    },
  },

  SearchResults: {
    type: 'object',
    required: ['total', 'results'],
    properties: {
      total: { type: 'integer' },
      results: {
        type: 'array',
        items: { $ref: '#/components/schemas/SearchResult' },
      },
    },
  },

  FollowEdgeView: {
    type: 'object',
    required: ['followerId', 'followeeId', 'followedAt'],
    properties: {
      followerId: { type: 'string', format: 'uuid' },
      followeeId: { type: 'string', format: 'uuid' },
      followedAt: dateTime,
    },
  },

  FollowEdgeList: {
    type: 'object',
    required: ['total', 'items'],
    properties: {
      total: { type: 'integer' },
      items: { type: 'array', items: { $ref: '#/components/schemas/FollowEdgeView' } },
    },
  },

  FriendRequestView: {
    type: 'object',
    required: ['id', 'requesterId', 'addresseeId', 'status', 'createdAt', 'respondedAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      requesterId: { type: 'string', format: 'uuid' },
      addresseeId: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['pending', 'accepted', 'declined', 'cancelled', 'ended'] },
      createdAt: dateTime,
      respondedAt: { ...dateTime, nullable: true },
    },
  },

  FriendRequestList: {
    type: 'object',
    required: ['total', 'items'],
    properties: {
      total: { type: 'integer' },
      items: { type: 'array', items: { $ref: '#/components/schemas/FriendRequestView' } },
    },
  },

  FriendList: {
    type: 'object',
    required: ['total', 'items'],
    properties: {
      total: { type: 'integer' },
      items: { type: 'array', items: { type: 'string', format: 'uuid' } },
    },
  },

  BlockEdgeView: {
    type: 'object',
    required: ['blockerId', 'blockedId', 'blockedAt'],
    properties: {
      blockerId: { type: 'string', format: 'uuid' },
      blockedId: { type: 'string', format: 'uuid' },
      blockedAt: dateTime,
    },
  },

  BlockEdgeList: {
    type: 'object',
    required: ['total', 'items'],
    properties: {
      total: { type: 'integer' },
      items: { type: 'array', items: { $ref: '#/components/schemas/BlockEdgeView' } },
    },
  },

  SendFriendRequestRequest: {
    type: 'object',
    required: ['addresseeId'],
    properties: {
      addresseeId: { type: 'string', format: 'uuid' },
    },
    additionalProperties: false,
  },

  RespondFriendRequestRequest: {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['accept', 'decline', 'cancel'] },
    },
    additionalProperties: false,
  },

  ConversationView: {
    type: 'object',
    required: ['id', 'participantA', 'participantB', 'createdAt', 'lastMessageAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      participantA: { type: 'string', format: 'uuid' },
      participantB: { type: 'string', format: 'uuid' },
      createdAt: dateTime,
      lastMessageAt: dateTime,
    },
  },

  MessageView: {
    type: 'object',
    required: ['id', 'conversationId', 'senderId', 'body', 'sentAt', 'editedAt', 'deletedAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      conversationId: { type: 'string', format: 'uuid' },
      senderId: { type: 'string', format: 'uuid' },
      body: { type: 'string' },
      sentAt: dateTime,
      editedAt: { ...dateTime, nullable: true },
      deletedAt: { ...dateTime, nullable: true },
    },
  },

  ConversationSummaryView: {
    type: 'object',
    required: ['conversation', 'unreadCount', 'lastMessage'],
    properties: {
      conversation: { $ref: '#/components/schemas/ConversationView' },
      unreadCount: { type: 'integer' },
      lastMessage: {
        oneOf: [
          { $ref: '#/components/schemas/MessageView' },
          { type: 'null' },
        ],
      },
    },
  },

  ConversationList: {
    type: 'object',
    required: ['total', 'items'],
    properties: {
      total: { type: 'integer' },
      items: { type: 'array', items: { $ref: '#/components/schemas/ConversationSummaryView' } },
    },
  },

  MessageList: {
    type: 'object',
    required: ['total', 'items'],
    properties: {
      total: { type: 'integer' },
      items: { type: 'array', items: { $ref: '#/components/schemas/MessageView' } },
    },
  },

  ConversationReadStateView: {
    type: 'object',
    required: ['conversationId', 'participantId', 'lastReadAt'],
    properties: {
      conversationId: { type: 'string', format: 'uuid' },
      participantId: { type: 'string', format: 'uuid' },
      lastReadAt: dateTime,
    },
  },

  UnreadCountView: {
    type: 'object',
    required: ['unreadCount'],
    properties: {
      unreadCount: { type: 'integer' },
    },
  },

  CreateConversationRequest: {
    type: 'object',
    required: ['playerId'],
    properties: {
      playerId: { type: 'string', format: 'uuid' },
    },
    additionalProperties: false,
  },

  SendMessageRequest: {
    type: 'object',
    required: ['body'],
    properties: {
      body: { type: 'string' },
    },
    additionalProperties: false,
  },

  EditMessageRequest: {
    type: 'object',
    required: ['body'],
    properties: {
      body: { type: 'string' },
    },
    additionalProperties: false,
  },

  TeamView: {
    type: 'object',
    required: ['id', 'slug', 'name', 'description', 'visibility', 'createdBy', 'createdAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      slug: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      visibility: { type: 'string', enum: ['public', 'private'] },
      createdBy: { type: 'string', format: 'uuid' },
      createdAt: dateTime,
    },
  },

  // The team detail route adds the viewer's own role, because the client cannot derive it reliably:
  // the member list is paginated and sorted owner → admin → member, so an ordinary member of a large
  // team is simply not on the page the client reads. Null for a signed-out viewer or a non-member.
  TeamDetailView: {
    type: 'object',
    required: ['id', 'slug', 'name', 'description', 'visibility', 'createdBy', 'createdAt', 'viewerRole'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      slug: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      visibility: { type: 'string', enum: ['public', 'private'] },
      createdBy: { type: 'string', format: 'uuid' },
      createdAt: dateTime,
      viewerRole: { type: 'string', enum: ['owner', 'admin', 'member'], nullable: true },
    },
  },

  TeamList: {
    type: 'object',
    required: ['items', 'total'],
    properties: {
      items: {
        type: 'array',
        items: { $ref: '#/components/schemas/TeamView' },
      },
      total: { type: 'integer' },
    },
  },

  MembershipView: {
    type: 'object',
    required: ['id', 'teamId', 'playerId', 'role', 'joinedAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      teamId: { type: 'string', format: 'uuid' },
      playerId: { type: 'string', format: 'uuid' },
      role: { type: 'string', enum: ['owner', 'admin', 'member'] },
      joinedAt: dateTime,
    },
  },

  MemberList: {
    type: 'object',
    required: ['items', 'total'],
    properties: {
      items: {
        type: 'array',
        items: { $ref: '#/components/schemas/MembershipView' },
      },
      total: { type: 'integer' },
    },
  },

  OwnershipTransferView: {
    type: 'object',
    required: ['oldOwner', 'newOwner'],
    properties: {
      oldOwner: { $ref: '#/components/schemas/MembershipView' },
      newOwner: { $ref: '#/components/schemas/MembershipView' },
    },
  },

  JoinRequestView: {
    type: 'object',
    required: ['id', 'teamId', 'playerId', 'status', 'createdAt', 'respondedAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      teamId: { type: 'string', format: 'uuid' },
      playerId: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['pending', 'accepted', 'declined', 'cancelled'] },
      createdAt: dateTime,
      respondedAt: { ...dateTime, nullable: true },
    },
  },

  JoinRequestList: {
    type: 'object',
    required: ['items', 'total'],
    properties: {
      items: {
        type: 'array',
        items: { $ref: '#/components/schemas/JoinRequestView' },
      },
      total: { type: 'integer' },
    },
  },

  ForumThreadView: {
    type: 'object',
    required: ['id', 'teamId', 'authorId', 'title', 'pinned', 'locked', 'createdAt', 'updatedAt', 'lastPostAt', 'deletedAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      teamId: { type: 'string', format: 'uuid' },
      authorId: { type: 'string', format: 'uuid' },
      title: { type: 'string' },
      pinned: { type: 'boolean' },
      locked: { type: 'boolean' },
      createdAt: dateTime,
      updatedAt: dateTime,
      lastPostAt: dateTime,
      deletedAt: { ...dateTime, nullable: true },
    },
  },

  ForumThreadList: {
    type: 'object',
    required: ['items', 'total'],
    properties: {
      items: {
        type: 'array',
        items: { $ref: '#/components/schemas/ForumThreadView' },
      },
      total: { type: 'integer' },
    },
  },

  ForumThreadCreateView: {
    type: 'object',
    required: ['thread', 'firstPost'],
    properties: {
      thread: { $ref: '#/components/schemas/ForumThreadView' },
      firstPost: { $ref: '#/components/schemas/ForumPostView' },
    },
  },

  ForumPostView: {
    type: 'object',
    // `editedAt`, not `updatedAt`: the presenter has always emitted `editedAt` (see
    // `forumPostView`), so the published `updatedAt` described a field the server never sends and
    // omitted one it always does. `MessageView` in this file had it right.
    required: ['id', 'threadId', 'authorId', 'body', 'createdAt', 'editedAt', 'deletedAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      threadId: { type: 'string', format: 'uuid' },
      authorId: { type: 'string', format: 'uuid' },
      body: { type: 'string' },
      createdAt: dateTime,
      editedAt: { ...dateTime, nullable: true },
      deletedAt: { ...dateTime, nullable: true },
    },
  },

  ForumPostList: {
    type: 'object',
    required: ['items', 'total'],
    properties: {
      items: {
        type: 'array',
        items: { $ref: '#/components/schemas/ForumPostView' },
      },
      total: { type: 'integer' },
    },
  },

  AchievementDefinitionView: {
    type: 'object',
    required: ['key', 'name', 'description', 'category', 'tier', 'points', 'hidden'],
    properties: {
      key: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      category: { type: 'string' },
      tier: { type: 'string', enum: ['bronze', 'silver', 'gold'] },
      points: { type: 'integer' },
      hidden: { type: 'boolean' },
      target: { type: 'integer' },
    },
  },

  AchievementDefinitionList: {
    type: 'object',
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: { $ref: '#/components/schemas/AchievementDefinitionView' },
      },
    },
  },

  PlayerAchievementView: {
    type: 'object',
    required: ['key', 'name', 'description', 'category', 'tier', 'points', 'hidden', 'progress', 'unlockedAt'],
    properties: {
      key: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      category: { type: 'string' },
      tier: { type: 'string', enum: ['bronze', 'silver', 'gold'] },
      points: { type: 'integer' },
      hidden: { type: 'boolean' },
      target: { type: 'integer' },
      progress: { type: 'integer' },
      unlockedAt: { ...dateTime, nullable: true },
    },
  },

  PlayerAchievementList: {
    type: 'object',
    required: ['items', 'total'],
    properties: {
      items: {
        type: 'array',
        items: { $ref: '#/components/schemas/PlayerAchievementView' },
      },
      total: { type: 'integer' },
    },
  },

  AchievementSummaryView: {
    type: 'object',
    required: ['unlockedCount', 'pointsTotal'],
    properties: {
      unlockedCount: { type: 'integer' },
      pointsTotal: { type: 'integer' },
    },
  },

  StudyView: {
    type: 'object',
    required: ['id', 'ownerId', 'name', 'description', 'visibility', 'createdAt', 'updatedAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      ownerId: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      description: { type: 'string' },
      visibility: { type: 'string', enum: ['public', 'unlisted', 'private'] },
      createdAt: dateTime,
      updatedAt: dateTime,
      deletedAt: { ...dateTime, nullable: true },
    },
  },

  StudyPage: {
    type: 'object',
    required: ['total', 'items'],
    properties: {
      total: { type: 'integer' },
      items: { type: 'array', items: { $ref: '#/components/schemas/StudyView' } },
    },
  },

  CollaboratorView: {
    type: 'object',
    required: ['studyId', 'playerId', 'role'],
    properties: {
      studyId: { type: 'string', format: 'uuid' },
      playerId: { type: 'string', format: 'uuid' },
      role: { type: 'string', enum: ['owner', 'contributor', 'viewer'] },
    },
  },

  CollaboratorPage: {
    type: 'object',
    required: ['total', 'items'],
    properties: {
      total: { type: 'integer' },
      items: { type: 'array', items: { $ref: '#/components/schemas/CollaboratorView' } },
    },
  },

  StudyOwnershipTransferView: {
    type: 'object',
    required: ['oldOwner', 'newOwner', 'study'],
    properties: {
      oldOwner: { $ref: '#/components/schemas/CollaboratorView' },
      newOwner: { $ref: '#/components/schemas/CollaboratorView' },
      study: { $ref: '#/components/schemas/StudyView' },
    },
  },

  ChapterView: {
    type: 'object',
    required: ['id', 'studyId', 'name', 'orderIndex', 'startingFen'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      studyId: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      orderIndex: { type: 'integer' },
      startingFen: { type: 'string' },
      deletedAt: { ...dateTime, nullable: true },
    },
  },

  ChapterList: {
    type: 'object',
    required: ['items'],
    properties: {
      items: { type: 'array', items: { $ref: '#/components/schemas/ChapterView' } },
    },
  },

  TreeNodeView: {
    type: 'object',
    required: ['id', 'chapterId', 'parentId', 'san', 'fenAfter', 'nags', 'orderIndex'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      chapterId: { type: 'string', format: 'uuid' },
      parentId: { type: 'string', format: 'uuid', nullable: true },
      san: { type: 'string' },
      fenAfter: { type: 'string' },
      comment: { type: 'string' },
      nags: { type: 'array', items: { type: 'integer' } },
      orderIndex: { type: 'integer' },
    },
  },

  ChapterDetailView: {
    type: 'object',
    required: ['chapter', 'tree'],
    properties: {
      chapter: { $ref: '#/components/schemas/ChapterView' },
      tree: { type: 'array', items: { $ref: '#/components/schemas/TreeNodeView' } },
    },
  },

  PgnExport: {
    type: 'string',
    description: 'PGN exported text',
  },

  // --- Learning & Courses ---
  CourseView: {
    type: 'object',
    required: ['id', 'authorId', 'slug', 'title', 'description', 'difficulty', 'published', 'createdAt', 'updatedAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      authorId: { type: 'string', format: 'uuid' },
      slug: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      difficulty: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] },
      published: { type: 'boolean' },
      createdAt: dateTime,
      updatedAt: dateTime,
      deletedAt: { ...dateTime, nullable: true },
    },
  },

  CoursePage: {
    type: 'object',
    required: ['total', 'items'],
    properties: {
      total: { type: 'integer' },
      items: { type: 'array', items: { $ref: '#/components/schemas/CourseView' } },
    },
  },

  LessonView: {
    type: 'object',
    required: ['id', 'courseId', 'title', 'orderIndex'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      courseId: { type: 'string', format: 'uuid' },
      title: { type: 'string' },
      orderIndex: { type: 'integer' },
      deletedAt: { ...dateTime, nullable: true },
    },
  },

  LessonList: {
    type: 'array',
    items: { $ref: '#/components/schemas/LessonView' },
  },

  StepView: {
    type: 'object',
    required: ['id', 'lessonId', 'orderIndex', 'kind'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      lessonId: { type: 'string', format: 'uuid' },
      orderIndex: { type: 'integer' },
      kind: { type: 'string', enum: ['text', 'move', 'quiz'] },
      prose: { type: 'string' },
      fen: { type: 'string' },
      expectedSan: { type: 'string' },
      hint: { type: 'string' },
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'string' } },
      correctIndex: { type: 'integer' },
      deletedAt: { ...dateTime, nullable: true },
    },
  },

  StepList: {
    type: 'array',
    items: { $ref: '#/components/schemas/StepView' },
  },

  LearnerStepView: {
    type: 'object',
    required: ['id', 'lessonId', 'orderIndex', 'kind'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      lessonId: { type: 'string', format: 'uuid' },
      orderIndex: { type: 'integer' },
      kind: { type: 'string', enum: ['text', 'move', 'quiz'] },
      prose: { type: 'string' },
      fen: { type: 'string' },
      hint: { type: 'string' },
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'string' } },
      deletedAt: { ...dateTime, nullable: true },
    },
  },

  LearnerStepList: {
    type: 'array',
    items: { $ref: '#/components/schemas/LearnerStepView' },
  },

  ProgressView: {
    type: 'object',
    required: ['playerId', 'courseId', 'lessonId', 'stepId', 'attempts'],
    properties: {
      playerId: { type: 'string', format: 'uuid' },
      courseId: { type: 'string', format: 'uuid' },
      lessonId: { type: 'string', format: 'uuid' },
      stepId: { type: 'string', format: 'uuid' },
      completedAt: { ...dateTime, nullable: true },
      attempts: { type: 'integer' },
    },
  },

  ProgressList: {
    type: 'array',
    items: { $ref: '#/components/schemas/ProgressView' },
  },

  CourseProgressSummaryView: {
    type: 'object',
    required: ['courseId', 'playerId', 'totalSteps', 'completedSteps'],
    properties: {
      courseId: { type: 'string', format: 'uuid' },
      playerId: { type: 'string', format: 'uuid' },
      totalSteps: { type: 'integer' },
      completedSteps: { type: 'integer' },
    },
  },

  AttemptResultView: {
    type: 'object',
    required: ['stepId', 'correct', 'attempts'],
    properties: {
      stepId: { type: 'string', format: 'uuid' },
      correct: { type: 'boolean' },
      completedAt: { ...dateTime, nullable: true },
      attempts: { type: 'integer' },
    },
  },

  // --- GraphQL (ADR-0073) ---
  // The response is deliberately not modelled: its shape is whatever the query selected, which is
  // the point of GraphQL and not something OpenAPI can describe without describing every query.
  GraphQLRequest: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'A read-only GraphQL query document' },
      variables: {
        type: 'object',
        additionalProperties: true,
        description: 'Values for the variables the query declares',
      },
    },
  },

  // --- Analysis (ADR-0113) ---
  AnalyzeRequest: {
    type: 'object',
    required: ['fen', 'variant'],
    properties: {
      fen: { type: 'string', minLength: 1, maxLength: 200 },
      variant: { type: 'string', enum: [...VARIANTS] },
      depth: { type: 'integer', minimum: 1, maximum: DEFAULT_ANALYSIS_LIMITS.maxDepth },
      nodes: { type: 'integer', minimum: 1, maximum: DEFAULT_ANALYSIS_LIMITS.maxNodes },
      movetimeMs: { type: 'integer', minimum: 1, maximum: DEFAULT_ANALYSIS_LIMITS.maxTimeMs },
      multiPv: { type: 'integer', minimum: 1, maximum: DEFAULT_ANALYSIS_LIMITS.maxMultiPv },
    },
    additionalProperties: false,
  },

  AnalysisLine: {
    type: 'object',
    required: ['multipv', 'evaluation', 'moves', 'depth', 'nodes', 'timeMs'],
    properties: {
      multipv: { type: 'integer' },
      evaluation: {
        type: 'object',
        required: ['type', 'value'],
        properties: {
          type: { type: 'string', enum: ['cp', 'mate'] },
          value: { type: 'number' },
        },
        additionalProperties: false,
      },
      moves: {
        type: 'array',
        items: { type: 'string' },
      },
      depth: { type: 'integer' },
      nodes: { type: 'integer' },
      timeMs: { type: 'integer' },
    },
    additionalProperties: false,
  },

  AnalysisResponse: {
    type: 'object',
    required: ['fen', 'variant', 'applied', 'lines'],
    properties: {
      // `terminal` present => `lines` is empty and no engine ran (ADR-0116).
      terminal: terminalOutcomeSchema,
      fen: { type: 'string' },
      variant: { type: 'string', enum: [...VARIANTS] },
      applied: {
        type: 'object',
        required: ['depth', 'movetimeMs', 'multiPv'],
        properties: {
          depth: { type: 'integer' },
          movetimeMs: { type: 'integer' },
          multiPv: { type: 'integer' },
          nodes: { type: 'integer' },
        },
        additionalProperties: false,
      },
      lines: {
        type: 'array',
        items: { $ref: '#/components/schemas/AnalysisLine' },
      },
    },
    additionalProperties: false,
  },

  // --- Move Explanation (ADR-0115) ---
  MoveExplanationRequest: {
    type: 'object',
    required: ['fen', 'variant', 'move'],
    properties: {
      fen: { type: 'string', minLength: 1, maxLength: 200 },
      variant: { type: 'string', enum: [...VARIANTS] },
      move: { type: 'string', minLength: 2, maxLength: 6 },
    },
    additionalProperties: false,
  },

  MoveExplanationResponse: {
    type: 'object',
    required: ['fen', 'variant', 'move', 'explanation', 'citation', 'providerId', 'model'],
    properties: {
      fen: { type: 'string' },
      variant: { type: 'string', enum: [...VARIANTS] },
      move: { type: 'string' },
      explanation: { type: 'string' },
      citation: {
        type: 'object',
        required: ['moveOutcome', 'evalKind', 'evalValue', 'evalLabel', 'bestMove', 'bestLine', 'depth'],
        properties: {
          // What the move achieved, tagged by `kind`: an evaluation from the perspective of the
          // player who moved, or a finished game. `eval*` alongside is what the engine's own best
          // move achieves from the same position; the pair is the judgement.
          // A real union, not an object with everything optional. Requiring only `kind` accepted a
          // half-filled evaluation, a terminal outcome with no result, and objects mixing both —
          // none of which the presenter can emit — so generated clients and schema tests could not
          // rely on either shape. Raised in the Qodo review of PR #135.
          moveOutcome: {
            oneOf: [
              {
                type: 'object',
                required: ['kind', 'evalKind', 'evalValue', 'evalLabel'],
                properties: {
                  kind: { type: 'string', enum: ['evaluation'] },
                  evalKind: { type: 'string', enum: ['cp', 'mate'] },
                  evalValue: { type: 'number' },
                  evalLabel: { type: 'string' },
                },
                additionalProperties: false,
              },
              {
                type: 'object',
                required: ['kind', 'reason', 'result'],
                properties: {
                  kind: { type: 'string', enum: ['terminal'] },
                  reason: { type: 'string', enum: [...TERMINAL_REASONS] },
                  result: { type: 'string', enum: [...RESULT_STRINGS] },
                },
                additionalProperties: false,
              },
            ],
          },
          evalKind: { type: 'string', enum: ['cp', 'mate'] },
          evalValue: { type: 'number' },
          evalLabel: { type: 'string' },
          bestMove: nullableString,
          bestLine: {
            type: 'array',
            items: { type: 'string' },
          },
          depth: { type: 'integer' },
        },
        additionalProperties: false,
      },
      providerId: { type: 'string' },
      model: { type: 'string' },
    },
    additionalProperties: false,
  },
};



