/**
 * @packageDocumentation
 * Reusable OpenAPI component schemas describing every request and response body.
 * These are the single source of truth for the wire contract; the presenters
 * emit exactly these shapes and the spec builder references them by name.
 */

import { ROLES, TIME_CONTROL_KINDS, VARIANTS } from '../domain';
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
      refreshToken: { type: 'string', description: 'Opaque, single-use refresh token.' },
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
      minRating: nullableInt,
      maxRating: nullableInt,
      createdAt: dateTime,
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
    required: ['refreshToken'],
    properties: { refreshToken: { type: 'string' } },
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
};
