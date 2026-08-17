/**
 * @packageDocumentation
 * The API's AI subsystem: Move Explanation composed on the dedicated analysis engine and the
 * provider-agnostic orchestrator (ADR-0115).
 */

export type { AiComposition, AiSettings } from './composition.js';
export {
  aiSettingsFromEnv,
  configuredAiProviders,
  createAiFromEnv,
  createMoveExplanation,
  DEFAULT_AI_SETTINGS,
} from './composition.js';
export type {
  MoveExplanationInput,
  MoveExplanationOutcome,
  MoveExplanationServiceOptions,
} from './move-explanation-service.js';
export { MoveExplanationService } from './move-explanation-service.js';
