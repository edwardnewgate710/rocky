import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SocialRuleError } from '../src/errors';

describe('SocialRuleError', () => {
  it('constructs with code and message', () => {
    const err = new SocialRuleError('self_relation', 'Self relation not allowed');
    assert.equal(err.code, 'self_relation');
    assert.equal(err.message, 'Self relation not allowed');
  });

  it('sets correct name property', () => {
    const err = new SocialRuleError('blocked', 'User is blocked');
    assert.equal(err.name, 'SocialRuleError');
  });

  // Every call site discriminates with `err instanceof SocialRuleError` before reading `.code`,
  // and subclassing Error is the one place a downlevel compile target silently breaks that.
  it('inherits from Error', () => {
    const err = new SocialRuleError('not_found', 'Not found');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof SocialRuleError);
  });
});
