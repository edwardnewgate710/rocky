/**
 * Unit tests for the dependency-free cookie helpers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRefreshCookie,
  clearRefreshCookie,
  parseCookies,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
} from '../src/http/cookie.js';

describe('parseCookies', () => {
  it('returns an empty object for undefined header', () => {
    assert.deepEqual(parseCookies(undefined), {});
  });

  it('returns an empty object for empty string', () => {
    assert.deepEqual(parseCookies(''), {});
  });

  it('parses a single name=value pair', () => {
    assert.deepEqual(parseCookies('foo=bar'), { foo: 'bar' });
  });

  it('parses multiple semicolon-separated pairs', () => {
    assert.deepEqual(parseCookies('a=1; b=2; c=3'), { a: '1', b: '2', c: '3' });
  });

  it('trims whitespace around names and values', () => {
    assert.deepEqual(parseCookies('  foo = bar  ;  baz = qux  '), { foo: 'bar', baz: 'qux' });
  });

  it('keeps the first occurrence of duplicate names', () => {
    assert.deepEqual(parseCookies('x=1; x=2'), { x: '1' });
  });

  it('ignores pairs without an equals sign', () => {
    assert.deepEqual(parseCookies('foo=bar; bare; baz=qux'), { foo: 'bar', baz: 'qux' });
  });

  it('handles values containing equals signs', () => {
    assert.deepEqual(parseCookies('token=abc=def=ghi'), { token: 'abc=def=ghi' });
  });

  it('handles empty values', () => {
    assert.deepEqual(parseCookies('foo=; bar='), { foo: '', bar: '' });
  });
});

describe('buildRefreshCookie', () => {
  it('builds a cookie with all required attributes (secure=true)', () => {
    const cookie = buildRefreshCookie('test-token', 3600, { secure: true });
    assert.ok(cookie.startsWith(`${REFRESH_COOKIE_NAME}=test-token;`));
    assert.ok(cookie.includes('HttpOnly'));
    assert.ok(cookie.includes('SameSite=Strict'));
    assert.ok(cookie.includes(`Path=${REFRESH_COOKIE_PATH}`));
    assert.ok(cookie.includes('Max-Age=3600'));
    assert.ok(cookie.includes('Secure'));
  });

  it('omits Secure when secure=false', () => {
    const cookie = buildRefreshCookie('test-token', 3600, { secure: false });
    assert.ok(!cookie.includes('Secure'));
    assert.ok(cookie.includes('HttpOnly'));
    assert.ok(cookie.includes('SameSite=Strict'));
  });

  it('uses the provided Max-Age value', () => {
    const cookie = buildRefreshCookie('tok', 7200, { secure: true });
    assert.ok(cookie.includes('Max-Age=7200'));
  });
});

describe('clearRefreshCookie', () => {
  it('builds a cookie that expires immediately (secure=true)', () => {
    const cookie = clearRefreshCookie({ secure: true });
    assert.ok(cookie.startsWith(`${REFRESH_COOKIE_NAME}=;`));
    assert.ok(cookie.includes('Max-Age=0'));
    assert.ok(cookie.includes('HttpOnly'));
    assert.ok(cookie.includes('SameSite=Strict'));
    assert.ok(cookie.includes(`Path=${REFRESH_COOKIE_PATH}`));
    assert.ok(cookie.includes('Secure'));
  });

  it('omits Secure when secure=false', () => {
    const cookie = clearRefreshCookie({ secure: false });
    assert.ok(!cookie.includes('Secure'));
    assert.ok(cookie.includes('Max-Age=0'));
  });
});
