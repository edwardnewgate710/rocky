import type { TournamentConfig } from './config';
import type { PairingStrategy } from './pairing';
import { RoundRobinPairing } from './round-robin';
import { SwissPairing } from './swiss';

/**
 * Build the pairing strategy for a tournament configuration.
 *
 * This is the single construction path for strategies: the Swiss round count
 * comes straight from `SwissConfig.rounds`, so the configured round count and
 * the strategy's termination can never diverge. Callers (tests, the API layer)
 * should always build strategies through this factory rather than instantiating
 * `SwissPairing`/`RoundRobinPairing` with an independently supplied round count.
 */
export function createPairingStrategy(config: TournamentConfig): PairingStrategy {
  switch (config.format) {
    case 'round_robin':
      return new RoundRobinPairing();
    case 'swiss':
      return new SwissPairing(config.rounds);
  }
}
