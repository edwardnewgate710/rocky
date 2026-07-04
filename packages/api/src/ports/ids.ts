/**
 * @packageDocumentation
 * The id-generation port. The default delegates to the persistence layer's
 * UUIDv7 generator so ids remain time-ordered and index-friendly across the
 * whole system; tests can inject a deterministic sequence.
 */

import { uuidv7 } from '@chess-platform/persistence';

/** Generates unique identifiers (used for users, sessions, seeks, token jti). */
export interface IdGenerator {
  next(): string;
}

/** UUIDv7 generator (time-ordered, collision-free). */
export const uuidv7Generator: IdGenerator = {
  next: () => uuidv7(),
};
