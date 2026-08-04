/**
 * Search controller — a pure, DOM-free orchestrator that manages the search
 * query lifecycle and per-result entity hydration.
 *
 * It mirrors {@link TournamentController}'s requestGeneration stale-response guard.
 */
import type { GambitClient } from '../api/client.js';
import type { SearchMode } from '../api/models.js';
import type { HydratedHit } from './search-results.js';
import { parseSearchHit } from './search-results.js';
import { shortId } from '../api/graphql.js';

export interface SearchCallbacks {
  onResults: (hits: readonly HydratedHit[], total: number) => void;
  onLoading: (loading: boolean) => void;
  onError: (message: string) => void;
}

export interface SearchControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: SearchCallbacks;
}

export class SearchController {
  private readonly client: GambitClient;
  private readonly callbacks: SearchCallbacks;
  private requestGeneration = 0;
  private disposed = false;

  constructor(opts: SearchControllerOptions) {
    this.client = opts.client;
    this.callbacks = opts.callbacks;
  }

  async search(q: string, mode?: SearchMode): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.requestGeneration;
    this.callbacks.onLoading(true);
    try {
      const searchRes = await this.client.search.query({
        q,
        ...(mode !== undefined ? { mode } : {}),
        limit: 10,
      });
      if (!this.isCurrent(generation)) return;

      const parsedHits = searchRes.results.map(parseSearchHit);

      // Hydrate tournament and game entities concurrently
      const entityResults = await Promise.all(
        parsedHits.map(async (hit) => {
          if (hit.type === 'tournament') {
            try {
              const detail = await this.client.tournaments.byId(hit.id);
              return { kind: 'tournament' as const, detail };
            } catch {
              return { kind: 'tournament' as const, detail: null };
            }
          }
          if (hit.type === 'game') {
            try {
              const summary = await this.client.games.byId(hit.id);
              return { kind: 'game' as const, summary };
            } catch {
              return { kind: 'game' as const, summary: null };
            }
          }
          return { kind: hit.type ?? 'unknown', detail: null, summary: null };
        }),
      );
      if (!this.isCurrent(generation)) return;

      // Collect all player IDs (from player hits and game whiteId/blackId)
      const playerIds: string[] = [];
      for (let i = 0; i < parsedHits.length; i++) {
        const hit = parsedHits[i]!;
        const entity = entityResults[i]!;
        if (hit.type === 'player') {
          playerIds.push(hit.id);
        } else if (entity.kind === 'game' && entity.summary) {
          if (entity.summary.whiteId) playerIds.push(entity.summary.whiteId);
          if (entity.summary.blackId) playerIds.push(entity.summary.blackId);
        }
      }

      // Batch resolve all player handles in a single call
      const playerMap = await this.client.graphql.resolvePlayers(playerIds);
      if (!this.isCurrent(generation)) return;

      const hydratedHits: HydratedHit[] = parsedHits.map((hit, i) => {
        const entity = entityResults[i]!;
        if (hit.type === 'tournament') {
          if (entity.detail) {
            return {
              ...hit,
              label: entity.detail.name,
              href: `/tournaments/${encodeURIComponent(hit.id)}`,
            };
          }
          return {
            ...hit,
            label: shortId(hit.id),
          };
        }
        if (hit.type === 'game') {
          if (entity.summary) {
            const w = entity.summary.whiteId
              ? (playerMap.get(entity.summary.whiteId)?.handle ?? shortId(entity.summary.whiteId))
              : 'Unknown';
            const b = entity.summary.blackId
              ? (playerMap.get(entity.summary.blackId)?.handle ?? shortId(entity.summary.blackId))
              : 'Unknown';
            return {
              ...hit,
              label: `${w} vs ${b}`,
              href: `/game/${encodeURIComponent(hit.id)}`,
            };
          }
          return {
            ...hit,
            label: shortId(hit.id),
          };
        }
        if (hit.type === 'player') {
          const player = playerMap.get(hit.id);
          if (player) {
            return {
              ...hit,
              label: player.handle,
              href: `/profile/${encodeURIComponent(player.handle)}`,
            };
          }
          return {
            ...hit,
            label: shortId(hit.id),
          };
        }
        return {
          ...hit,
          label: shortId(hit.id),
        };
      });

      this.callbacks.onResults(hydratedHits, searchRes.total);
    } catch (err) {
      if (this.isCurrent(generation)) {
        this.callbacks.onError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (this.isCurrent(generation)) {
        this.callbacks.onLoading(false);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.requestGeneration;
  }
}
