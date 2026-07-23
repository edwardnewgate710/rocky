/**
 * @packageDocumentation
 * Reusable OpenAPI component schemas describing every request and response body.
 * These are the single source of truth for the wire contract; the presenters
 * emit exactly these shapes and the spec builder references them by name.
 */

import { ROLES, SEEK_COLORS, TIME_CONTROL_KINDS, VARIANTS } from '../domain';
import type { ComponentSchemas, JsonSchema } from './types';

const dateTime: JsonSchema = { type: 'string', format: 'date-time' };
const nullableString: JsonSchema = { type: 'string', nullable: true };
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
    required: ['id', 'createdAt', 'expiresAt', 'revokedAt', 'lastSeenAt', 'lastIp', 'lastUserAgent'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      createdAt: dateTime,
      expiresAt: dateTime,
      revokedAt: { ...dateTime, nullable: true },
      lastSeenAt: { ...dateTime, nullable: true },
      lastIp: nullableString,
      lastUserAgent: nullableString,
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
      authenticatorSelection: { type: 'object', properties: { userVerification: { type: 'string' }, requireResidentKey: { type: 'boolean' } } },
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
    required: ['challenge', 'timeout', 'rpId', 'allowCredentials', 'userVerification'],
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
};
