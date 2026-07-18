import type { RequestContext, HandlerResult } from '../http/context';
import { json } from '../http/context';
import { HttpError } from '../http/errors';
import { TournamentService } from './service';
import { ArenaService } from './arena.service';
import { standingView, arenaStandingView } from './presenters';
import type { RouteDeps } from '../routes';

export function createLiveTournamentHandler(deps: RouteDeps) {
  return async (ctx: RequestContext): Promise<HandlerResult> => {
    const { id } = ctx.params as { id: string };

    // Dispatch on the stored format so arenas get their own standings shape,
    // mirroring GET /standings. A missing tournament is a 404; any other
    // failure (e.g. the repository) is left to propagate to the central error
    // handler as a 5xx rather than being masked as a 404.
    const stored = await deps.tournamentRepo.findById(id);
    if (!stored) throw HttpError.notFound('Tournament not found');

    const games = await deps.liveView.activeGames(id);

    if (stored.snapshot.config.format === 'arena') {
      const arenaService = new ArenaService(deps.tournamentRepo, deps.gameLauncher, () => deps.clock.now());
      const standings = (await arenaService.getStandings(id)).map(arenaStandingView);
      return json(200, { games, standings });
    }

    const service = new TournamentService(deps.tournamentRepo, deps.gameLauncher);
    const tournament = await service.load(id);

    // Present standings through the same view as GET /standings so both
    // endpoints expose an identical, stable shape.
    const standings = tournament.standings().map(standingView);
    return json(200, { games, standings });
  };
}
