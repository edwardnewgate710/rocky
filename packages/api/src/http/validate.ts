/**
 * @packageDocumentation
 * Tiny, dependency-free request validation. Each helper narrows an `unknown`
 * value to a concrete type or throws {@link HttpError} (422) with a structured
 * `details` map, so malformed input never reaches the services.
 */

import { HttpError } from './errors';

/** Assert the body is a JSON object and return it typed. */
export function asObject(body: unknown, field = 'body'): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw HttpError.validation('expected a JSON object', { [field]: 'must be an object' });
  }
  return body as Record<string, unknown>;
}

export interface StringRules {
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: RegExp;
  readonly trim?: boolean;
}

/** Require a string field satisfying the rules. */
export function reqString(obj: Record<string, unknown>, key: string, rules: StringRules = {}): string {
  const raw = obj[key];
  if (typeof raw !== 'string') {
    throw HttpError.validation(`"${key}" is required`, { [key]: 'must be a string' });
  }
  const value = rules.trim ? raw.trim() : raw;
  if (rules.min !== undefined && value.length < rules.min) {
    throw HttpError.validation(`"${key}" is too short`, { [key]: `min length ${rules.min}` });
  }
  if (rules.max !== undefined && value.length > rules.max) {
    throw HttpError.validation(`"${key}" is too long`, { [key]: `max length ${rules.max}` });
  }
  if (rules.pattern && !rules.pattern.test(value)) {
    throw HttpError.validation(`"${key}" has an invalid format`, { [key]: 'invalid format' });
  }
  return value;
}

/** Optional string; returns undefined when absent/null. */
export function optString(
  obj: Record<string, unknown>,
  key: string,
  rules: StringRules = {},
): string | undefined {
  if (obj[key] === undefined || obj[key] === null) return undefined;
  return reqString(obj, key, rules);
}

/** Require a boolean field. */
export function reqBoolean(obj: Record<string, unknown>, key: string): boolean {
  const raw = obj[key];
  if (typeof raw !== 'boolean') {
    throw HttpError.validation(`"${key}" is required`, { [key]: 'must be a boolean' });
  }
  return raw;
}

/** Optional boolean with a default. */
export function optBoolean(obj: Record<string, unknown>, key: string, fallback: boolean): boolean {
  if (obj[key] === undefined || obj[key] === null) return fallback;
  return reqBoolean(obj, key);
}

export interface IntRules {
  readonly min?: number;
  readonly max?: number;
}

/** Optional integer; returns undefined when absent/null. */
export function optInt(
  obj: Record<string, unknown>,
  key: string,
  rules: IntRules = {},
): number | undefined {
  const raw = obj[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw HttpError.validation(`"${key}" must be an integer`, { [key]: 'must be an integer' });
  }
  if (rules.min !== undefined && raw < rules.min) {
    throw HttpError.validation(`"${key}" is too small`, { [key]: `min ${rules.min}` });
  }
  if (rules.max !== undefined && raw > rules.max) {
    throw HttpError.validation(`"${key}" is too large`, { [key]: `max ${rules.max}` });
  }
  return raw;
}

/** Parse a bounded positive integer from a query string, with a default. */
export function parseLimit(query: URLSearchParams, def: number, max: number): number {
  const raw = query.get('limit');
  if (raw === null) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw HttpError.validation('"limit" must be a positive integer', { limit: 'invalid' });
  }
  return Math.min(n, max);
}

/** Require the value be one of `allowed`. */
export function oneOf<T extends string>(value: string, allowed: readonly T[], key: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw HttpError.validation(`"${key}" is not a valid value`, {
      [key]: `must be one of: ${allowed.join(', ')}`,
    });
  }
  return value as T;
}
