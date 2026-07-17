import type { RequestContext, HandlerResult } from '../http/context';
import { json } from '../http/context';
import { TournamentService } from './service';
import { standingView } from './presenters';
import type { RouteDeps } from '../routes';

export function createLiveTournamentHandler(deps: RouteDeps) {
  return async (ctx: RequestContext): Promise<HandlerResult> => {
    const { id } = ctx.params as { id: string };
    const service = new TournamentService(deps.tournamentRepo, deps.gameLauncher);

    // `load` throws HttpError.notFound for a missing tournament (→ 404). Any
    // other failure (e.g. the repository) is left to propagate to the central
    // error handler as a 5xx, rather than being masked as a 404.
    const tournament = await service.load(id);

    // Present standings through the same view as GET /standings so both
    // endpoints expose an identical, stable shape.
    const standings = tournament.standings().map(standingView);
    const games = await deps.liveView.activeGames(id);

    return json(200, { games, standings });
  };
}
