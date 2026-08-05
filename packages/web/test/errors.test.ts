import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BadRequestError,
  ConflictError,
  HttpError,
  NotFoundError,
  RateLimitError,
  ServerError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
  httpErrorFrom,
  isRetryableStatus,
  parseRetryAfterMs,
} from '../src/net/errors.js';

test('maps status codes to specific HttpError subclasses', () => {
  assert.ok(httpErrorFrom(400, undefined) instanceof BadRequestError);
  assert.ok(httpErrorFrom(401, undefined) instanceof UnauthorizedError);
  assert.ok(httpErrorFrom(404, undefined) instanceof NotFoundError);
  assert.ok(httpErrorFrom(409, undefined) instanceof ConflictError);
  assert.ok(httpErrorFrom(422, undefined) instanceof ValidationError);
  assert.ok(httpErrorFrom(429, undefined) instanceof RateLimitError);
  // 503 is its own class so callers can tell "subsystem not configured" from a fault, but it is
  // still a `ServerError` — narrowing it must not fall out of an existing 5xx branch.
  assert.ok(httpErrorFrom(503, undefined) instanceof ServiceUnavailableError);
  assert.ok(httpErrorFrom(503, undefined) instanceof ServerError);
  assert.equal(httpErrorFrom(500, undefined) instanceof ServiceUnavailableError, false);
  const teapot = httpErrorFrom(418, undefined);
  assert.ok(teapot instanceof HttpError);
  assert.equal(teapot.constructor, HttpError);
});

test('folds a server error envelope into the typed error', () => {
  const err = httpErrorFrom(404, {
    error: { code: 'not_found', message: 'no such user', requestId: 'req-123' },
  });
  assert.equal(err.status, 404);
  assert.equal(err.code, 'not_found');
  assert.equal(err.message, 'no such user');
  assert.equal(err.requestId, 'req-123');
  assert.equal(err.name, 'NotFoundError');
});

test('synthesizes code/message when there is no envelope', () => {
  const err = httpErrorFrom(500, undefined);
  assert.equal(err.code, 'server_error');
  assert.equal(err.message, 'HTTP 500');
  assert.equal(err.requestId, undefined);
});

test('retryable classification of statuses', () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(502), true);
  assert.equal(isRetryableStatus(504), true);
  assert.equal(isRetryableStatus(500), false);
  assert.equal(isRetryableStatus(404), false);
  assert.equal(httpErrorFrom(503, undefined).retryable, true);
  assert.equal(httpErrorFrom(400, undefined).retryable, false);
});

test('carries a Retry-After hint on the error', () => {
  const err = httpErrorFrom(429, undefined, { retryAfterMs: 2000 });
  assert.equal(err.retryAfterMs, 2000);
});

test('parseRetryAfterMs handles delta-seconds, ignores dates and blanks', () => {
  assert.equal(parseRetryAfterMs('2'), 2000);
  assert.equal(parseRetryAfterMs('0'), 0);
  assert.equal(parseRetryAfterMs(undefined), undefined);
  assert.equal(parseRetryAfterMs(''), undefined);
  assert.equal(parseRetryAfterMs('Wed, 21 Oct 2099 07:28:00 GMT'), undefined);
});
