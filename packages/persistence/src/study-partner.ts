/** Durable contracts for the server-authoritative Study Partner lifecycle. */
import type { Variant } from '@chess-platform/core';

export type StudyPartnerSessionStatus = 'active' | 'completed';
export type StudyPartnerTurnRequestStatus = 'claimed' | 'accepted' | 'succeeded' | 'failed' | 'exhausted';
/** Claimed requests have not charged yet and may be failed transactionally after this interval. */
export const STUDY_PARTNER_CLAIM_TIMEOUT_MS = 5 * 60 * 1000;
/** Protect live accepted work before an orphaned intent becomes terminal and releases the session. */
export const STUDY_PARTNER_ACCEPTED_RECOVERY_MS = 60 * 60 * 1000;

export interface StudyPartnerSessionRow {
  readonly id: string;
  readonly ownerId: string;
  readonly variant: Variant;
  readonly initialFen: string;
  readonly currentFen: string;
  readonly status: StudyPartnerSessionStatus;
  readonly version: number;
  readonly turnCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
}

export interface StudyPartnerTurnRow {
  readonly id: string;
  readonly sessionId: string;
  readonly turnNumber: number;
  readonly move: string;
  readonly fenBefore: string;
  readonly fenAfter: string;
  /** Runtime-validated by the API boundary before it is returned to a caller. */
  readonly coaching: unknown;
  readonly coachingVersion: number;
  readonly sessionVersion: number;
  readonly createdAt: Date;
}

export interface StudyPartnerSessionDetail {
  readonly session: StudyPartnerSessionRow;
  readonly turns: readonly StudyPartnerTurnRow[];
}

export interface NewStudyPartnerSession {
  readonly id: string;
  readonly ownerId: string;
  readonly variant: Variant;
  readonly initialFen: string;
  readonly now: Date;
}

export interface ClaimStudyPartnerTurn {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly expectedVersion: number;
  readonly maxTurns: number;
  readonly now: Date;
}

export type ClaimStudyPartnerTurnResult =
  | { readonly kind: 'claimed' }
  | { readonly kind: 'replayed'; readonly turn: StudyPartnerTurnRow }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'inactive' }
  | { readonly kind: 'version_conflict'; readonly currentVersion: number }
  | { readonly kind: 'turn_limit_reached' }
  | { readonly kind: 'idempotency_conflict' }
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'exhausted' };

export interface StudyPartnerTurnRequestRef {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly now: Date;
}

export interface CommitStudyPartnerTurn extends StudyPartnerTurnRequestRef {
  readonly turnId: string;
  readonly expectedVersion: number;
  readonly move: string;
  readonly fenBefore: string;
  readonly fenAfter: string;
  readonly coaching: Readonly<Record<string, unknown>>;
  readonly coachingVersion: number;
}

export type CommitStudyPartnerTurnResult =
  | { readonly kind: 'committed'; readonly turn: StudyPartnerTurnRow }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'conflict' };

export interface EndStudyPartnerSession {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly expectedVersion: number;
  readonly now: Date;
}

export type EndStudyPartnerSessionResult =
  | { readonly kind: 'ended'; readonly session: StudyPartnerSessionRow }
  | { readonly kind: 'already_ended'; readonly session: StudyPartnerSessionRow }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'version_conflict'; readonly currentVersion: number }
  | { readonly kind: 'turn_in_progress' };

export type DeleteStudyPartnerSessionResult =
  | { readonly kind: 'deleted' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'turn_in_progress' };

export interface StudyPartnerRepository {
  createSession(input: NewStudyPartnerSession): Promise<StudyPartnerSessionRow>;
  findOwnedSession(sessionId: string, ownerId: string): Promise<StudyPartnerSessionDetail | null>;
  claimTurn(input: ClaimStudyPartnerTurn): Promise<ClaimStudyPartnerTurnResult>;
  acceptTurn(ref: StudyPartnerTurnRequestRef): Promise<boolean>;
  /** Release a definitively refused pre-work admission without quarantining the session. */
  refuseTurn(ref: StudyPartnerTurnRequestRef): Promise<void>;
  failTurn(ref: StudyPartnerTurnRequestRef): Promise<void>;
  commitTurn(input: CommitStudyPartnerTurn): Promise<CommitStudyPartnerTurnResult>;
  endSession(input: EndStudyPartnerSession): Promise<EndStudyPartnerSessionResult>;
  deleteOwnedSession(
    sessionId: string,
    ownerId: string,
    now: Date,
  ): Promise<DeleteStudyPartnerSessionResult>;
}
