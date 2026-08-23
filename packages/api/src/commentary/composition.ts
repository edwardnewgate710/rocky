/**
 * @packageDocumentation
 * Composition for tournament commentary (ADR-0130).
 *
 * The feature borrows both of its expensive subsystems and owns neither: the analysis service from
 * ADR-0113 for the one search a commentary quotes, and the AI orchestrator for the prose. Both
 * halves are required — a commentary with no engine behind it is an unfounded verdict, and one with
 * no provider is not a commentary at all — so a deployment missing either composes nothing and the
 * routes answer 503.
 */
import { TournamentCommentator } from '@chess-platform/ai-features';
import type {
  AnalysisProvider,
  AnalysisRequest,
  EngineCapabilities,
  EngineResult,
  PlayRequest,
  PlayResult,
} from '@chess-platform/engine';
import { Tournament, createPairingStrategy } from '@chess-platform/tournament';
import { isArenaSnapshot } from '@chess-platform/persistence';
import type { TournamentsRepository, UsersRepository } from '@chess-platform/persistence';

import type { AiComposition } from '../ai/composition.js';
import type { AnalysisPort } from '../analysis/service.js';
import type { FinishedGameArchive } from '../tournament/finished-game.js';

import type { PlayerHandles, TournamentFacts, TournamentLookup, TournamentLookupFailure } from './ports.js';
import { TournamentCommentaryService } from './tournament-commentary-service.js';

/**
 * An `AnalysisProvider` that refuses.
 *
 * `TournamentCommentator` requires an engine in its constructor and searches with it whenever its
 * caller supplies no pre-computed analysis. The production service always supplies it, and this is
 * what makes that a guarantee rather than a habit: if a future edit ever stops supplying it, the
 * request fails loudly here instead of quietly running a search at limits the library chose and
 * this API's policy never approved.
 *
 * Not a `null` and not an omitted option, because the library's type demands one — so the honest
 * shape is a provider that exists and says no.
 */
class RefusingAnalysisProvider implements AnalysisProvider {
  /**
   * @throws always. Reaching this is the bug it exists to surface: the production service supplies
   * pre-computed analysis on every path, so a search here is one the library chose for itself.
   */
  async analyze(_request: AnalysisRequest): Promise<readonly EngineResult[]> {
    throw new Error(
      'Tournament commentary must supply pre-computed analysis; the library may not search on its own.',
    );
  }

  /** @throws always. Commentary analyses positions; it never asks an engine for a move. */
  async play(_request: PlayRequest): Promise<PlayResult> {
    throw new Error('Tournament commentary never asks an engine to play.');
  }

  /**
   * @returns `undefined` — this provider serves no variant, which is the honest answer for one that
   * refuses every call.
   */
  capabilitiesFor(_variant: string): EngineCapabilities | undefined {
    return undefined;
  }
}

/**
 * Read round-based tournaments out of the repository.
 *
 * Restores the aggregate rather than reading the snapshot directly so that callers get the
 * aggregate's own answers — `pairingForGame`, `isRoundComplete`, `standingsAfterRound` — instead of
 * a second implementation of them over the same rows.
 */
export class RepositoryTournamentLookup implements TournamentLookup {
  constructor(private readonly tournaments: TournamentsRepository) {}

  /**
   * @param tournamentId - the tournament named in the request path.
   * @returns the aggregate, or why it cannot be commentated.
   */
  async roundBased(tournamentId: string): Promise<TournamentFacts | TournamentLookupFailure> {
    const stored = await this.tournaments.findById(tournamentId);
    if (!stored) return 'not_found';
    if (isArenaSnapshot(stored.snapshot)) return 'arena';
    return Tournament.restore(stored.snapshot, createPairingStrategy(stored.snapshot.config));
  }
}

/**
 * Resolve player ids to handles, and to nothing else.
 *
 * `UsersRepository.findByIds` returns whole account rows — email, email hash, verification
 * timestamp, moderation flags — in one round trip. This projects the one field a narrative can use
 * before the rows reach anything else, so the private columns exist in this function and nowhere
 * downstream of it.
 */
export class RepositoryPlayerHandles implements PlayerHandles {
  constructor(private readonly users: UsersRepository) {}

  /**
   * @param playerIds - the ids to resolve; duplicates are harmless.
   * @returns handle by id, omitting ids with no account.
   */
  async handles(playerIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (playerIds.length === 0) return new Map();
    const rows = await this.users.findByIds(playerIds);
    const byId = new Map<string, string>();
    for (const row of rows) byId.set(row.id, row.handle);
    return byId;
  }
}

export interface TournamentCommentaryCompositionOptions {
  readonly ai?: AiComposition | undefined;
  readonly analysis?: AnalysisPort | undefined;
  readonly archive: FinishedGameArchive;
  readonly tournaments: TournamentLookup;
  readonly players: PlayerHandles;
}

/**
 * Build the commentary service, or `undefined` when this deployment cannot serve it.
 *
 * `temperature` and `maxTokens` are fixed here for the reason `createMoveExplanation` fixes them:
 * no request field reaches them, so no caller can raise the token ceiling that bounds what a single
 * accepted request costs.
 *
 * @param options - the two borrowed subsystems and the three reads the service needs.
 * @returns the service, or `undefined` when the engine or the provider is absent.
 */
export function createTournamentCommentary(
  options: TournamentCommentaryCompositionOptions,
): TournamentCommentaryService | undefined {
  const { ai, analysis } = options;
  if (!ai || !analysis) return undefined;

  const commentator = new TournamentCommentator({
    engine: new RefusingAnalysisProvider(),
    ai: ai.orchestrator,
    defaultVariant: 'standard',
    temperature: ai.settings.temperature,
    maxTokens: ai.settings.maxOutputTokens,
  });

  return new TournamentCommentaryService({
    analysis,
    commentator,
    archive: options.archive,
    tournaments: options.tournaments,
    players: options.players,
  });
}
