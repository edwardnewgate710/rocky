import type {
  StudyPartnerSession,
  StudyPartnerTurn,
  SubmitStudyPartnerTurnResult,
} from './service.js';
import type { StudyPartnerCoachingV1 } from './coaching.js';

export interface StudyPartnerTurnView {
  readonly id: string;
  readonly turnNumber: number;
  readonly move: string;
  readonly fenBefore: string;
  readonly fenAfter: string;
  readonly coaching: StudyPartnerCoachingV1;
  readonly sessionVersion: number;
  readonly createdAt: string;
}

export interface StudyPartnerSessionView {
  readonly id: string;
  readonly variant: string;
  readonly initialFen: string;
  readonly currentFen: string;
  readonly status: 'active' | 'completed';
  readonly version: number;
  readonly turnCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly turns: readonly StudyPartnerTurnView[];
}

export interface SubmitStudyPartnerTurnView {
  readonly turn: StudyPartnerTurnView;
  readonly replayed: boolean;
}

export function studyPartnerTurnView(turn: StudyPartnerTurn): StudyPartnerTurnView {
  return {
    id: turn.id,
    turnNumber: turn.turnNumber,
    move: turn.move,
    fenBefore: turn.fenBefore,
    fenAfter: turn.fenAfter,
    coaching: turn.coaching,
    sessionVersion: turn.sessionVersion,
    createdAt: turn.createdAt.toISOString(),
  };
}

export function studyPartnerSessionView(session: StudyPartnerSession): StudyPartnerSessionView {
  return {
    id: session.id,
    variant: session.variant,
    initialFen: session.initialFen,
    currentFen: session.currentFen,
    status: session.status,
    version: session.version,
    turnCount: session.turnCount,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    completedAt: session.completedAt?.toISOString() ?? null,
    turns: session.turns.map(studyPartnerTurnView),
  };
}

export function submitStudyPartnerTurnView(
  result: SubmitStudyPartnerTurnResult,
): SubmitStudyPartnerTurnView {
  return { turn: studyPartnerTurnView(result.turn), replayed: result.replayed };
}
