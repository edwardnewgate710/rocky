/**
 * Composition for opening exploration (ADR-0127).
 *
 * Kept as a factory rather than a `new` at the call site for one reason: availability must be
 * derived from something real. An empty database can identify nothing, so a deployment carrying one
 * must not advertise the capability; returning `undefined` makes `GET /v1/capabilities` report the
 * truth by the same mechanism every other flag uses, instead of publishing a constant `true` that
 * no longer means anything the day the dataset moves.
 */
import { BundledOpeningDatabase } from '@chess-platform/ai-features';
import { OpeningExplorationService } from './opening-exploration-service.js';

/**
 * Build the service, or `undefined` when there is nothing for it to identify.
 *
 * @returns the service, or `undefined` for an empty dataset — which is what makes the
 * `openingExplorer` capability a derived fact rather than a constant `true`.
 */
export function createOpeningExploration(): OpeningExplorationService | undefined {
  const database = new BundledOpeningDatabase();
  if (database.allEntries.length === 0) return undefined;
  return new OpeningExplorationService({ database });
}
