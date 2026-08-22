/**
 * Composition for the Coach orchestrator (ADR-0129).
 *
 * The Coach owns no dependency of its own. It is exactly the five feature services this deployment
 * already builds, so its capability is derived from theirs rather than declared: a deployment with
 * an engine and a provider coaches fully, one with an engine but no provider coaches without the
 * narrative explanation, and one with neither still identifies openings, because opening exploration
 * needs no engine at all (ADR-0127).
 *
 * `undefined` — and so `coach: false` at `GET /v1/capabilities` — only when *none* of the five is
 * present, which is the one case where the endpoint could say nothing about any position.
 */
import type { AnalysisPort } from '../analysis/service.js';
import { CoachService } from './coach-service.js';
import type { CoachFeatureBundle, CoachFeatureFactory } from './coach-service.js';

export interface CoachCompositionOptions {
  /** The shared analysis service, absent on a deployment with no engine. */
  readonly analysis?: AnalysisPort | undefined;
  /** Builds the feature bundle over whichever analysis port it is handed. */
  readonly features: CoachFeatureFactory;
}

/**
 * Build the Coach service, or `undefined` when this deployment composes nothing to orchestrate.
 *
 * Readiness is probed by building the bundle once, at boot, against the shared analysis service and
 * inspecting what came back. Probing rather than re-deriving the five availability conditions is
 * deliberate: restating them here would be a second copy of the composition rules, free to drift
 * from the factory that actually builds them, and the drift would show up as a capability flag that
 * disagrees with the endpoint it describes.
 *
 * @param options - the shared analysis port and the feature factory.
 * @returns the orchestrator, or `undefined` when the probe finds every feature absent.
 */
export function createCoach(options: CoachCompositionOptions): CoachService | undefined {
  const probe: CoachFeatureBundle = options.features(options.analysis);
  const composable = [
    probe.mistakePrediction,
    probe.moveExplanation,
    probe.puzzleGeneration,
    probe.openingExploration,
    probe.endgameTraining,
  ].some((service) => service !== undefined);
  if (!composable) return undefined;
  return new CoachService({
    ...(options.analysis ? { analysis: options.analysis } : {}),
    features: options.features,
  });
}
