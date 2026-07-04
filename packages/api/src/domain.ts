/**
 * @packageDocumentation
 * Shared domain enumerations and parsers. The canonical lists mirror the domain
 * packages and the seeded lookup tables in the persistence migration, so the API
 * validates against exactly the values the engine and database accept.
 */

import type { Variant } from '@chess-platform/core';
import type { TimeControl } from '@chess-platform/game';
import type { Role } from '@chess-platform/persistence';
import { HttpError } from './http/errors';
import { asObject, oneOf } from './http/validate';

/** Every playable variant (mirrors `Variant` in @chess-platform/core). */
export const VARIANTS: readonly Variant[] = [
  'standard',
  'chess960',
  'kingofthehill',
  'atomic',
  'crazyhouse',
  'threecheck',
  'horde',
  'racingkings',
];

/** Every assignable role (mirrors `Role` in @chess-platform/persistence). */
export const ROLES: readonly Role[] = [
  'user',
  'coach',
  'tournament_director',
  'moderator',
  'admin',
];

/** Clock kinds accepted for a time control. */
export const TIME_CONTROL_KINDS: readonly TimeControl['kind'][] = [
  'increment',
  'delay',
  'sudden_death',
  'unlimited',
];

/** Handles: 3–30 chars, alphanumerics plus `_` and `-`. */
export const HANDLE_PATTERN = /^[A-Za-z0-9_-]{3,30}$/;

/** Parse a variant code from an arbitrary string. */
export function parseVariant(value: string, key = 'variant'): Variant {
  return oneOf(value, VARIANTS, key);
}

/** Parse a role code from an arbitrary string. */
export function parseRole(value: string, key = 'role'): Role {
  return oneOf(value, ROLES, key);
}

const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — generous correspondence ceiling.

/** Validate and normalize a time-control object from a request body. */
export function parseTimeControl(raw: unknown, field = 'timeControl'): TimeControl {
  const obj = asObject(raw, field);
  const kind = oneOf(String(obj['kind'] ?? ''), TIME_CONTROL_KINDS, `${field}.kind`);
  const initialMs = duration(obj['initialMs'], `${field}.initialMs`);
  const incrementMs = duration(obj['incrementMs'], `${field}.incrementMs`);
  const delayMs = duration(obj['delayMs'], `${field}.delayMs`);

  if (kind === 'unlimited') {
    if (initialMs !== 0 || incrementMs !== 0 || delayMs !== 0) {
      throw HttpError.validation('unlimited time control must have zero durations', {
        [field]: 'initialMs/incrementMs/delayMs must be 0 for unlimited',
      });
    }
  } else if (initialMs <= 0) {
    throw HttpError.validation('time control requires a positive initialMs', {
      [`${field}.initialMs`]: 'must be > 0',
    });
  }
  if (kind === 'increment' && delayMs !== 0) {
    throw HttpError.validation('increment time control cannot set delayMs', {
      [`${field}.delayMs`]: 'must be 0 for increment',
    });
  }
  if (kind === 'delay' && incrementMs !== 0) {
    throw HttpError.validation('delay time control cannot set incrementMs', {
      [`${field}.incrementMs`]: 'must be 0 for delay',
    });
  }
  return { initialMs, incrementMs, delayMs, kind };
}

function duration(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw HttpError.validation(`"${key}" must be a non-negative integer`, {
      [key]: 'non-negative integer (milliseconds)',
    });
  }
  if (value > MAX_DURATION_MS) {
    throw HttpError.validation(`"${key}" exceeds the maximum`, { [key]: `max ${MAX_DURATION_MS}` });
  }
  return value;
}
