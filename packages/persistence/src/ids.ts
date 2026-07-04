/**
 * @packageDocumentation
 * UUIDv7 generation (RFC 9562). Time-ordered ids give B-tree index locality for
 * high-volume inserts (games, events, sessions, audit rows) while remaining
 * collision-free and generatable client-side. Postgres 16 has no native
 * `uuidv7()`, so we mint ids here; the column type stays a standard `UUID`.
 *
 * Layout (128 bits):
 *   48 bits  unix_ts_ms  | 4 bits ver(=7) | 12 bits rand_a
 *   2 bits   variant(=0b10) | 62 bits rand_b
 *
 * We use `rand_a` as a 12-bit monotonic counter within a millisecond so ids
 * generated in the same ms still sort in creation order (important for the
 * event-store head and audit ordering). On counter overflow the timestamp is
 * nudged forward by 1ms to preserve monotonicity.
 */

import { randomBytes } from 'node:crypto';

const TWO_40 = 2 ** 40;
const TWO_32 = 2 ** 32;
const TWO_24 = 2 ** 24;
const TWO_16 = 2 ** 16;
const TWO_8 = 2 ** 8;

let lastMs = -1;
let counter = 0; // 12-bit sub-millisecond monotonic counter

/** Generate a UUIDv7 string. `now` is injectable for deterministic tests. */
export function uuidv7(now: number = Date.now()): string {
  let ms = Math.floor(now);
  if (ms === lastMs) {
    counter = (counter + 1) & 0xfff;
    if (counter === 0) ms = lastMs + 1; // counter wrapped: advance the clock
  } else if (ms > lastMs) {
    counter = 0;
  } else {
    // Clock moved backwards; pin to lastMs and keep incrementing to stay monotonic.
    ms = lastMs;
    counter = (counter + 1) & 0xfff;
    if (counter === 0) ms = lastMs + 1;
  }
  lastMs = ms;

  const b = randomBytes(16);
  b[0] = Math.floor(ms / TWO_40) & 0xff;
  b[1] = Math.floor(ms / TWO_32) & 0xff;
  b[2] = Math.floor(ms / TWO_24) & 0xff;
  b[3] = Math.floor(ms / TWO_16) & 0xff;
  b[4] = Math.floor(ms / TWO_8) & 0xff;
  b[5] = ms & 0xff;
  b[6] = 0x70 | ((counter >> 8) & 0x0f); // version 7 + high nibble of counter
  b[7] = counter & 0xff; // low byte of counter
  b[8] = 0x80 | (b[8]! & 0x3f); // variant 0b10

  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Extract the UUID version nibble (7 for UUIDv7). */
export function uuidVersion(id: string): number {
  return parseInt(id[14]!, 16);
}

/** Extract the 48-bit millisecond timestamp embedded in a UUIDv7. */
export function uuidv7Timestamp(id: string): number {
  const hex = id.replace(/-/g, '').slice(0, 12);
  return parseInt(hex, 16);
}
