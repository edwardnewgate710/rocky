import test from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7, uuidVersion, uuidv7Timestamp } from '../src/ids';

test('uuidv7 has version 7 nibble and RFC-9562 variant bits', () => {
  const id = uuidv7();
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(uuidVersion(id), 7);
});

test('uuidv7 embeds the 48-bit millisecond timestamp', () => {
  // Use a timestamp ahead of the generator's monotonic clock so it is embedded
  // faithfully (a past timestamp is intentionally pinned forward for uniqueness).
  const now = Date.now() + 1_000_000;
  assert.equal(uuidv7Timestamp(uuidv7(now)), now);
});

test('uuidv7 is unique and monotonic within a fixed millisecond', () => {
  const ids = Array.from({ length: 5000 }, () => uuidv7(1_234_567_890));
  assert.equal(new Set(ids).size, ids.length, 'all ids unique');
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted, 'creation order == lexicographic order');
});

test('uuidv7 increases across increasing timestamps', () => {
  const base = Date.now() + 2_000_000;
  assert.ok(uuidv7(base) < uuidv7(base + 1000));
});
