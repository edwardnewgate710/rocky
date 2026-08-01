import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../src/pagination';

describe('paginate', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];

  it('returns all items when options are omitted', () => {
    const page = paginate(items);
    assert.equal(page.total, 5);
    assert.deepEqual(page.items, ['a', 'b', 'c', 'd', 'e']);
  });

  it('returns all items when options are empty object', () => {
    const page = paginate(items, {});
    assert.equal(page.total, 5);
    assert.deepEqual(page.items, ['a', 'b', 'c', 'd', 'e']);
  });

  it('applies limit correctly', () => {
    const page = paginate(items, { limit: 2 });
    assert.equal(page.total, 5);
    assert.deepEqual(page.items, ['a', 'b']);
  });

  it('applies offset correctly', () => {
    const page = paginate(items, { offset: 2 });
    assert.equal(page.total, 5);
    assert.deepEqual(page.items, ['c', 'd', 'e']);
  });

  it('applies limit and offset together', () => {
    const page = paginate(items, { limit: 2, offset: 1 });
    assert.equal(page.total, 5);
    assert.deepEqual(page.items, ['b', 'c']);
  });

  it('clamps negative limit to 0', () => {
    const page = paginate(items, { limit: -3 });
    assert.equal(page.total, 5);
    assert.deepEqual(page.items, []);
  });

  it('clamps negative offset to 0', () => {
    const page = paginate(items, { offset: -2, limit: 3 });
    assert.equal(page.total, 5);
    assert.deepEqual(page.items, ['a', 'b', 'c']);
  });

  it('returns empty items array when offset exceeds total', () => {
    const page = paginate(items, { offset: 10 });
    assert.equal(page.total, 5);
    assert.deepEqual(page.items, []);
  });

  it('handles empty input array', () => {
    const page = paginate([], { limit: 10, offset: 0 });
    assert.equal(page.total, 0);
    assert.deepEqual(page.items, []);
  });

  // `Number('abc')` is NaN, which is how malformed pagination arrives from a query string. Left to
  // Math.max, NaN propagated into slice and returned an empty page while `total` still reported the
  // real count — a caller saw "5 results" above an empty list, with no error raised anywhere.
  it('treats a NaN offset as absent rather than emptying the page', () => {
    const page = paginate(items, { offset: Number('abc'), limit: 2 });
    assert.equal(page.total, 5);
    assert.deepEqual(page.items, ['a', 'b']);
  });

  it('treats a NaN limit as zero, not as unlimited', () => {
    const page = paginate(items, { limit: Number.NaN });
    assert.equal(page.total, 5);
    assert.deepEqual(page.items, []);
  });

  it('reads an infinite limit as all remaining and an infinite offset as past the end', () => {
    assert.deepEqual(paginate(items, { limit: Number.POSITIVE_INFINITY }).items, items);
    assert.deepEqual(paginate(items, { offset: Number.POSITIVE_INFINITY }).items, []);
    assert.deepEqual(paginate(items, { offset: Number.NEGATIVE_INFINITY, limit: 1 }).items, ['a']);
  });

  it('truncates fractional limit and offset', () => {
    const page = paginate(items, { offset: 1.9, limit: 2.7 });
    assert.deepEqual(page.items, ['b', 'c']);
  });

  it('preserves total count independent of limit and offset', () => {
    const page1 = paginate(items, { limit: 1, offset: 0 });
    const page2 = paginate(items, { limit: 10, offset: 20 });
    assert.equal(page1.total, 5);
    assert.equal(page2.total, 5);
  });
});
