/**
 * Achievements controller — a pure, DOM-free orchestrator for the achievements section of a
 * profile.
 *
 * Mirrors TeamsController: a `requestGeneration` stale-response guard and `dispose()`, no timer.
 * Progress changes when a game ends, which this page has no way to learn about, so polling here
 * would be a request per interval to observe something that only moves while the user is elsewhere.
 */
import type { GambitClient } from '../api/client.js';
import type { AchievementSummary, PlayerAchievement } from '../api/models.js';
import { ServiceUnavailableError } from '../net/errors.js';

export interface AchievementsCallbacks {
  onAchievements: (
    achievements: readonly PlayerAchievement[],
    summary: AchievementSummary,
  ) => void;
  onError: (message: string) => void;
  /**
   * The deployment runs without achievements (`ACHIEVEMENTS_ENABLED` unset — see
   * `services/gateway/src/serve.ts`), so every route answers 503. That is a configuration, not a
   * fault, and it is the same on every profile: the section removes itself rather than showing an
   * error the visitor can do nothing about.
   *
   * Fires at most once per controller — see the latch in {@link AchievementsController.load}.
   */
  onUnavailable: () => void;
}

export interface AchievementsControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: AchievementsCallbacks;
}

export class AchievementsController {
  private readonly client: GambitClient;
  private readonly callbacks: AchievementsCallbacks;
  private requestGeneration = 0;
  private disposed = false;
  private unavailable = false;

  constructor(opts: AchievementsControllerOptions) {
    this.client = opts.client;
    this.callbacks = opts.callbacks;
  }

  /**
   * Load one player's achievements and their summary.
   *
   * Keyed by player id, not by handle: both routes take an id, and the profile page already holds
   * one by the time this runs.
   *
   * Answers nothing once the deployment has been found to run without achievements: that is a
   * process-lifetime setting, so re-asking on the next profile would spend two requests — each one
   * up to `maxAttempts` because 503 is classified retryable — to be told the same thing.
   */
  async load(playerId: string): Promise<void> {
    if (this.disposed || this.unavailable) return;
    const generation = ++this.requestGeneration;
    try {
      // The summary is not derivable from the page of achievements — it counts the whole catalogue,
      // including hidden entries this player has not earned and so never receives.
      const [list, summary] = await Promise.all([
        this.client.achievements.forPlayer(playerId),
        this.client.achievements.summary(playerId),
      ]);
      if (!this.isCurrent(generation)) return;
      this.callbacks.onAchievements(list.items, summary);
    } catch (err) {
      if (!this.isCurrent(generation)) return;
      // Only a 503 from the API means "this deployment has no achievements". A 500 is a fault, and
      // a foreign error that happens to carry `status: 503` is not the API speaking at all — both
      // must still be reported.
      if (err instanceof ServiceUnavailableError) {
        this.unavailable = true;
        this.callbacks.onUnavailable();
        return;
      }
      this.callbacks.onError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Invalidate any in-flight load, so a late response cannot paint the next profile. */
  reset(): void {
    if (this.disposed) return;
    this.requestGeneration++;
  }

  dispose(): void {
    this.disposed = true;
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.requestGeneration;
  }
}
