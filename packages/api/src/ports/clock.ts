/**
 * @packageDocumentation
 * The clock port. All time reads in the API go through {@link Clock} so tests can
 * drive deterministic token expiry, session lifetimes, and audit timestamps
 * without sleeping.
 */

/** A source of the current wall-clock time in milliseconds since the epoch. */
export interface Clock {
  now(): number;
}

/** The real system clock. */
export const systemClock: Clock = {
  now: () => Date.now(),
};

/** A controllable clock for tests. */
export class ManualClock implements Clock {
  constructor(private current: number) {}
  now(): number {
    return this.current;
  }
  /** Advance the clock by `ms` milliseconds. */
  advance(ms: number): void {
    this.current += ms;
  }
  /** Set the clock to an absolute time. */
  set(ms: number): void {
    this.current = ms;
  }
}
