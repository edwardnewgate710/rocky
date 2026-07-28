import type { SearchableDocument } from './search';

/**
 * Minimal structural input for projecting a game entity into a SearchableDocument.
 *
 * Mapping from persistence layer:
 * - `id`: `GameSummaryRow.id`
 * - `whiteHandle`: resolved handle of `whiteId` (e.g. from joining `users`)
 * - `blackHandle`: resolved handle of `blackId` (e.g. from joining `users`)
 * - `variant`: `GameSummaryRow.variant`
 * - `speed`: `GameSummaryRow.speed`
 * - `result`: `GameSummaryRow.result ?? '*'`
 * - `rated`: `GameSummaryRow.rated`
 * - `eco`: `GameSummaryRow.opening_eco` (when present)
 */
export interface GameDocumentInput {
  readonly id: string;
  readonly whiteHandle: string;
  readonly blackHandle: string;
  readonly variant: string;
  readonly speed: string;
  readonly result: string;
  readonly rated: boolean;
  readonly eco?: string;
}

/**
 * Minimal structural input for projecting a player entity into a SearchableDocument.
 *
 * Mapping from persistence layer:
 * - `id`: `UserRow.id`
 * - `handle`: `UserRow.handle`
 * - `country`: `UserRow.country` (when present)
 *
 * SECURITY NOTE: NEVER include email, email_hash, or flags in the projection.
 * Player documents strictly index `handle` and optional `country`.
 */
export interface PlayerDocumentInput {
  readonly id: string;
  readonly handle: string;
  readonly country?: string;
}

/**
 * Minimal structural input for projecting a tournament entity into a SearchableDocument.
 *
 * Mapping from persistence layer:
 * - `id`: `TournamentSummaryRow.id`
 * - `name`: `TournamentSummaryRow.name`
 * - `format`: `TournamentSummaryRow.format`
 * - `state`: `TournamentSummaryRow.state`
 */
export interface TournamentDocumentInput {
  readonly id: string;
  readonly name: string;
  readonly format: string;
  readonly state: string;
}

/**
 * Project a game entity into a SearchableDocument.
 * Namespaced id: `game:<id>`.
 * Canonicalized lowercase fields: `type`, `variant`, `speed`, `result`, `rated`, `white`, `black`, `winner` (when finished), `eco` (when present).
 */
export function gameToDocument(input: GameDocumentInput): SearchableDocument {
  const fields: Record<string, string> = {
    type: 'game',
    variant: input.variant.toLowerCase(),
    speed: input.speed.toLowerCase(),
    result: input.result.toLowerCase(),
    rated: input.rated ? 'true' : 'false',
  };

  if (input.whiteHandle && input.whiteHandle.trim().length > 0) {
    fields.white = input.whiteHandle.trim().toLowerCase();
  }

  if (input.blackHandle && input.blackHandle.trim().length > 0) {
    fields.black = input.blackHandle.trim().toLowerCase();
  }

  const resultLower = input.result.trim().toLowerCase();
  if (resultLower === '1-0' && input.whiteHandle && input.whiteHandle.trim().length > 0) {
    fields.winner = input.whiteHandle.trim().toLowerCase();
  } else if (resultLower === '0-1' && input.blackHandle && input.blackHandle.trim().length > 0) {
    fields.winner = input.blackHandle.trim().toLowerCase();
  } else if (resultLower === '1/2-1/2') {
    fields.winner = 'draw';
  }

  if (input.eco && input.eco.trim().length > 0) {
    fields.eco = input.eco.trim().toLowerCase();
  }

  const textParts = [
    input.whiteHandle,
    input.blackHandle,
    input.eco,
    input.variant,
    input.speed,
  ].filter((v): v is string => Boolean(v && v.trim().length > 0));

  return {
    id: `game:${input.id}`,
    text: textParts.join(' '),
    fields,
  };
}

/**
 * Project a player entity into a SearchableDocument.
 * Namespaced id: `player:<id>`.
 * Canonicalized lowercase fields: `type`, `country` (when present).
 * SECURITY: `email`, `email_hash`, and `flags` are NEVER indexed.
 */
export function playerToDocument(input: PlayerDocumentInput): SearchableDocument {
  const fields: Record<string, string> = {
    type: 'player',
  };

  if (input.country && input.country.trim().length > 0) {
    fields.country = input.country.trim().toLowerCase();
  }

  return {
    id: `player:${input.id}`,
    text: input.handle,
    fields,
  };
}

/**
 * Project a tournament entity into a SearchableDocument.
 * Namespaced id: `tournament:<id>`.
 * Canonicalized lowercase fields: `type`, `format`, `state`.
 */
export function tournamentToDocument(input: TournamentDocumentInput): SearchableDocument {
  const fields: Record<string, string> = {
    type: 'tournament',
    format: input.format.toLowerCase(),
    state: input.state.toLowerCase(),
  };

  return {
    id: `tournament:${input.id}`,
    text: input.name,
    fields,
  };
}
