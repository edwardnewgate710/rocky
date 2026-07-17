/**
 * @packageDocumentation
 * Error types raised by the persistence layer. Kept driver-agnostic so callers
 * can branch on domain-level failures without importing `pg`.
 */

/** Base class for all persistence errors. */
export class PersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersistenceError';
  }
}

/** A uniqueness conflict while creating an identity record. */
export class DuplicateUserError extends PersistenceError {
  constructor() {
    super('user handle or identity already exists');
    this.name = 'DuplicateUserError';
  }
}

/**
 * Raised when an optimistic append conflicts with the current head sequence of a
 * game's event log (a concurrent writer won the race). The caller should reload
 * the log and retry from the new head.
 */
export class ConcurrencyError extends PersistenceError {
  constructor(
    readonly gameId: string,
    readonly expectedSeq: number,
    readonly actualSeq?: number,
  ) {
    super(
      `concurrent append to game ${gameId}: expected head ${expectedSeq}` +
        (actualSeq === undefined ? '' : `, found ${actualSeq}`),
    );
    this.name = 'ConcurrencyError';
  }
}

/** Raised when a migration cannot be applied or history integrity is violated. */
export class MigrationError extends PersistenceError {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}
