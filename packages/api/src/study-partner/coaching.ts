import type { Variant } from '@chess-platform/core';
import type { CoachOmissionReason, CoachOutcome, CoachSection } from '../coach/coach-service.js';
import {
  endgameNextView,
  mistakePredictionView,
  openingExplorationView,
  type CoachPuzzleView,
  type EndgameNextView,
  type MistakePredictionView,
  type MoveExplanationCitationView,
  type OpeningExplorationView,
} from '../presenters.js';

export const STUDY_PARTNER_COACHING_VERSION = 1 as const;

export interface StudyPartnerExplanationView {
  readonly fen: string;
  readonly variant: string;
  readonly move: string;
  readonly explanation: string;
  readonly citation: MoveExplanationCitationView;
}

export type StudyPartnerSection<T> =
  | { readonly kind: 'present'; readonly value: T }
  | { readonly kind: 'omitted'; readonly reason: CoachOmissionReason };

export interface StudyPartnerCoachingV1 {
  readonly version: typeof STUDY_PARTNER_COACHING_VERSION;
  readonly fen: string;
  readonly variant: Variant;
  readonly move: string;
  readonly mistake: StudyPartnerSection<MistakePredictionView>;
  readonly explanation: StudyPartnerSection<StudyPartnerExplanationView>;
  readonly opening: StudyPartnerSection<OpeningExplorationView>;
  readonly puzzle: StudyPartnerSection<CoachPuzzleView>;
  readonly endgame: StudyPartnerSection<EndgameNextView>;
}

function omitted<T>(section: CoachSection<T>): StudyPartnerSection<never> {
  if (section.kind === 'present') throw new Error('present section passed to omitted()');
  return { kind: 'omitted', reason: section.reason };
}

/** Project the production Coach result without provider metadata or withheld answers. */
export function studyPartnerCoaching(outcome: CoachOutcome): StudyPartnerCoachingV1 {
  if (outcome.move === null) throw new Error('Study Partner coaching requires a move');
  const mistake: StudyPartnerSection<MistakePredictionView> = outcome.mistake.kind === 'present'
    ? { kind: 'present', value: mistakePredictionView(outcome.mistake.value) }
    : omitted(outcome.mistake);
  const explanation: StudyPartnerSection<StudyPartnerExplanationView> =
    outcome.explanation.kind === 'present'
      ? {
          kind: 'present',
          value: {
            fen: outcome.explanation.value.fen,
            variant: outcome.explanation.value.variant,
            move: outcome.explanation.value.move,
            explanation: outcome.explanation.value.explanation,
            citation: {
              moveOutcome: outcome.explanation.value.citation.moveOutcome,
              evalKind: outcome.explanation.value.citation.evalKind,
              evalValue: outcome.explanation.value.citation.evalValue,
              evalLabel: outcome.explanation.value.citation.evalLabel,
              bestMove: outcome.explanation.value.citation.bestMove,
              bestLine: [...outcome.explanation.value.citation.bestLine],
              depth: outcome.explanation.value.citation.depth,
            },
          },
        }
      : omitted(outcome.explanation);
  const opening: StudyPartnerSection<OpeningExplorationView> = outcome.opening.kind === 'present'
    ? { kind: 'present', value: openingExplorationView(outcome.opening.value) }
    : omitted(outcome.opening);
  const puzzle: StudyPartnerSection<CoachPuzzleView> = outcome.puzzle.kind === 'present'
    ? {
        kind: 'present',
        value: {
          kind: 'puzzle',
          fen: outcome.puzzle.value.fen,
          variant: outcome.puzzle.value.variant,
          difficulty: outcome.puzzle.value.difficulty,
        },
      }
    : omitted(outcome.puzzle);
  const endgame: StudyPartnerSection<EndgameNextView> = outcome.endgame.kind === 'present'
    ? { kind: 'present', value: endgameNextView(outcome.endgame.value) }
    : omitted(outcome.endgame);
  return {
    version: STUDY_PARTNER_COACHING_VERSION,
    fen: outcome.fen,
    variant: outcome.variant as Variant,
    move: outcome.move,
    mistake,
    explanation,
    opening,
    puzzle,
    endgame,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The DB is server-owned; this guard rejects corrupt or unknown projection versions at its edge. */
export function storedStudyPartnerCoaching(value: unknown): StudyPartnerCoachingV1 {
  if (!isRecord(value) || value['version'] !== STUDY_PARTNER_COACHING_VERSION) {
    throw new Error('unsupported stored Study Partner coaching projection');
  }
  for (const key of ['fen', 'variant', 'move'] as const) {
    if (typeof value[key] !== 'string') throw new Error('invalid stored Study Partner coaching projection');
  }
  for (const key of ['mistake', 'explanation', 'opening', 'puzzle', 'endgame'] as const) {
    const section = value[key];
    if (!isRecord(section) || (section['kind'] !== 'present' && section['kind'] !== 'omitted')) {
      throw new Error('invalid stored Study Partner coaching section');
    }
  }
  if (value['variant'] !== 'standard') {
    throw new Error('invalid stored Study Partner coaching variant');
  }
  const stored = value as unknown as StudyPartnerCoachingV1;
  const mistake: StudyPartnerSection<MistakePredictionView> = stored.mistake.kind === 'present'
    ? { kind: 'present', value: mistakePredictionView(stored.mistake.value) }
    : { kind: 'omitted', reason: stored.mistake.reason };
  const explanation: StudyPartnerSection<StudyPartnerExplanationView> =
    stored.explanation.kind === 'present'
      ? {
          kind: 'present',
          value: {
            fen: stored.explanation.value.fen,
            variant: stored.explanation.value.variant,
            move: stored.explanation.value.move,
            explanation: stored.explanation.value.explanation,
            citation: {
              moveOutcome: stored.explanation.value.citation.moveOutcome,
              evalKind: stored.explanation.value.citation.evalKind,
              evalValue: stored.explanation.value.citation.evalValue,
              evalLabel: stored.explanation.value.citation.evalLabel,
              bestMove: stored.explanation.value.citation.bestMove,
              bestLine: [...stored.explanation.value.citation.bestLine],
              depth: stored.explanation.value.citation.depth,
            },
          },
        }
      : { kind: 'omitted', reason: stored.explanation.reason };
  const opening: StudyPartnerSection<OpeningExplorationView> = stored.opening.kind === 'present'
    ? { kind: 'present', value: openingExplorationView(stored.opening.value) }
    : { kind: 'omitted', reason: stored.opening.reason };
  const puzzle: StudyPartnerSection<CoachPuzzleView> = stored.puzzle.kind === 'present'
    ? {
        kind: 'present',
        value: {
          kind: 'puzzle',
          fen: stored.puzzle.value.fen,
          variant: stored.puzzle.value.variant,
          difficulty: stored.puzzle.value.difficulty,
        },
      }
    : { kind: 'omitted', reason: stored.puzzle.reason };
  const endgame: StudyPartnerSection<EndgameNextView> = stored.endgame.kind === 'present'
    ? { kind: 'present', value: endgameNextView(stored.endgame.value) }
    : { kind: 'omitted', reason: stored.endgame.reason };
  return {
    version: STUDY_PARTNER_COACHING_VERSION,
    fen: stored.fen,
    variant: 'standard',
    move: stored.move,
    mistake,
    explanation,
    opening,
    puzzle,
    endgame,
  };
}
