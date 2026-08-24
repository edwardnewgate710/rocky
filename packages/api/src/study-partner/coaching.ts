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

function projectSection<Input, Output>(
  section: CoachSection<Input> | StudyPartnerSection<Input>,
  present: (value: Input) => Output,
): StudyPartnerSection<Output> {
  return section.kind === 'present'
    ? { kind: 'present', value: present(section.value) }
    : { kind: 'omitted', reason: section.reason };
}

function explanationView(value: StudyPartnerExplanationView): StudyPartnerExplanationView {
  return {
    fen: value.fen,
    variant: value.variant,
    move: value.move,
    explanation: value.explanation,
    citation: {
      moveOutcome: value.citation.moveOutcome,
      evalKind: value.citation.evalKind,
      evalValue: value.citation.evalValue,
      evalLabel: value.citation.evalLabel,
      bestMove: value.citation.bestMove,
      bestLine: [...value.citation.bestLine],
      depth: value.citation.depth,
    },
  };
}

function puzzleView(value: CoachPuzzleView): CoachPuzzleView {
  return {
    kind: 'puzzle',
    fen: value.fen,
    variant: value.variant,
    difficulty: value.difficulty,
  };
}

/** Project the production Coach result without provider metadata or withheld answers. */
export function studyPartnerCoaching(outcome: CoachOutcome): StudyPartnerCoachingV1 {
  if (outcome.move === null) throw new Error('Study Partner coaching requires a move');
  const mistake = projectSection(outcome.mistake, mistakePredictionView);
  const explanation = projectSection(outcome.explanation, explanationView);
  const opening = projectSection(outcome.opening, openingExplorationView);
  const puzzle = projectSection(outcome.puzzle, puzzleView);
  const endgame = projectSection(outcome.endgame, endgameNextView);
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
  const mistake = projectSection(stored.mistake, mistakePredictionView);
  const explanation = projectSection(stored.explanation, explanationView);
  const opening = projectSection(stored.opening, openingExplorationView);
  const puzzle = projectSection(stored.puzzle, puzzleView);
  const endgame = projectSection(stored.endgame, endgameNextView);
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
