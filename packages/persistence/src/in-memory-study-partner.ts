import type {
  ClaimStudyPartnerTurn,
  ClaimStudyPartnerTurnResult,
  CommitStudyPartnerTurn,
  CommitStudyPartnerTurnResult,
  DeleteStudyPartnerSessionResult,
  EndStudyPartnerSession,
  EndStudyPartnerSessionResult,
  NewStudyPartnerSession,
  StudyPartnerRepository,
  StudyPartnerSessionDetail,
  StudyPartnerSessionRow,
  StudyPartnerTurnRequestRef,
  StudyPartnerTurnRequestStatus,
  StudyPartnerTurnRow,
} from './study-partner.js';
import {
  STUDY_PARTNER_ACCEPTED_DELETE_PROTECTION_MS,
  STUDY_PARTNER_CLAIM_TIMEOUT_MS,
} from './study-partner.js';

interface TurnRequest {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly key: string;
  readonly requestHash: string;
  readonly expectedVersion: number;
  readonly status: StudyPartnerTurnRequestStatus;
  readonly turnId: string | null;
  readonly updatedAt: Date;
}

const requestMapKey = (sessionId: string, key: string): string => `${sessionId}\u0000${key}`;

/** Deterministic repository used by API tests; each method is one synchronous state transition. */
export class InMemoryStudyPartnerRepository implements StudyPartnerRepository {
  private readonly sessions = new Map<string, StudyPartnerSessionRow>();
  private readonly turns = new Map<string, StudyPartnerTurnRow[]>();
  private readonly requests = new Map<string, TurnRequest>();

  async createSession(input: NewStudyPartnerSession): Promise<StudyPartnerSessionRow> {
    const row: StudyPartnerSessionRow = {
      id: input.id,
      ownerId: input.ownerId,
      variant: input.variant,
      initialFen: input.initialFen,
      currentFen: input.initialFen,
      status: 'active',
      version: 0,
      turnCount: 0,
      createdAt: input.now,
      updatedAt: input.now,
      completedAt: null,
    };
    if (this.sessions.has(row.id)) throw new Error('study partner session already exists');
    this.sessions.set(row.id, row);
    this.turns.set(row.id, []);
    return row;
  }

  async findOwnedSession(sessionId: string, ownerId: string): Promise<StudyPartnerSessionDetail | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.ownerId !== ownerId) return null;
    return { session, turns: [...(this.turns.get(sessionId) ?? [])] };
  }

  async claimTurn(input: ClaimStudyPartnerTurn): Promise<ClaimStudyPartnerTurnResult> {
    const session = this.sessions.get(input.sessionId);
    if (!session || session.ownerId !== input.ownerId) return { kind: 'not_found' };

    for (const [key, request] of this.requests) {
      if (
        request.sessionId === input.sessionId
        && request.status === 'claimed'
        && input.now.getTime() - request.updatedAt.getTime() >= STUDY_PARTNER_CLAIM_TIMEOUT_MS
      ) {
        this.requests.set(key, { ...request, status: 'failed', updatedAt: input.now });
      }
    }

    const mapKey = requestMapKey(input.sessionId, input.idempotencyKey);
    const existing = this.requests.get(mapKey);
    if (existing) {
      if (existing.ownerId !== input.ownerId || existing.requestHash !== input.requestHash) {
        return { kind: 'idempotency_conflict' };
      }
      if (existing.status === 'succeeded' && existing.turnId) {
        const turn = (this.turns.get(input.sessionId) ?? []).find((candidate) => candidate.id === existing.turnId);
        if (!turn) throw new Error('succeeded study partner request has no turn');
        return { kind: 'replayed', turn };
      }
      if (existing.status === 'failed') return { kind: 'failed' };
      return { kind: 'in_progress' };
    }

    if (session.status !== 'active') return { kind: 'inactive' };
    if (session.version !== input.expectedVersion) {
      return { kind: 'version_conflict', currentVersion: session.version };
    }
    if (session.turnCount >= input.maxTurns) return { kind: 'turn_limit_reached' };
    const anotherActive = [...this.requests.values()].some(
      (request) => request.sessionId === input.sessionId
        && (request.status === 'claimed' || request.status === 'accepted'),
    );
    if (anotherActive) return { kind: 'in_progress' };

    this.requests.set(mapKey, {
      sessionId: input.sessionId,
      ownerId: input.ownerId,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
      expectedVersion: input.expectedVersion,
      status: 'claimed',
      turnId: null,
      updatedAt: input.now,
    });
    return { kind: 'claimed' };
  }

  async acceptTurn(ref: StudyPartnerTurnRequestRef): Promise<boolean> {
    const mapKey = requestMapKey(ref.sessionId, ref.idempotencyKey);
    const request = this.requests.get(mapKey);
    if (!request || request.ownerId !== ref.ownerId || request.requestHash !== ref.requestHash) return false;
    if (request.status !== 'claimed') return false;
    this.requests.set(mapKey, { ...request, status: 'accepted', updatedAt: ref.now });
    return true;
  }

  async failTurn(ref: StudyPartnerTurnRequestRef): Promise<void> {
    const mapKey = requestMapKey(ref.sessionId, ref.idempotencyKey);
    const request = this.requests.get(mapKey);
    if (!request || request.ownerId !== ref.ownerId || request.requestHash !== ref.requestHash) return;
    if (request.status !== 'claimed' && request.status !== 'accepted') return;
    this.requests.set(mapKey, { ...request, status: 'failed', updatedAt: ref.now });
  }

  async commitTurn(input: CommitStudyPartnerTurn): Promise<CommitStudyPartnerTurnResult> {
    const session = this.sessions.get(input.sessionId);
    if (!session || session.ownerId !== input.ownerId) return { kind: 'not_found' };
    const mapKey = requestMapKey(input.sessionId, input.idempotencyKey);
    const request = this.requests.get(mapKey);
    if (
      !request
      || request.ownerId !== input.ownerId
      || request.requestHash !== input.requestHash
      || request.status !== 'accepted'
      || session.status !== 'active'
      || session.version !== input.expectedVersion
      || session.currentFen !== input.fenBefore
    ) return { kind: 'conflict' };

    const turn: StudyPartnerTurnRow = {
      id: input.turnId,
      sessionId: input.sessionId,
      turnNumber: session.turnCount + 1,
      move: input.move,
      fenBefore: input.fenBefore,
      fenAfter: input.fenAfter,
      coaching: input.coaching,
      coachingVersion: input.coachingVersion,
      sessionVersion: session.version + 1,
      createdAt: input.now,
    };
    const sessionTurns = this.turns.get(input.sessionId) ?? [];
    this.turns.set(input.sessionId, [...sessionTurns, turn]);
    this.sessions.set(input.sessionId, {
      ...session,
      currentFen: input.fenAfter,
      version: session.version + 1,
      turnCount: session.turnCount + 1,
      updatedAt: input.now,
    });
    this.requests.set(mapKey, { ...request, status: 'succeeded', turnId: turn.id, updatedAt: input.now });
    return { kind: 'committed', turn };
  }

  async endSession(input: EndStudyPartnerSession): Promise<EndStudyPartnerSessionResult> {
    const session = this.sessions.get(input.sessionId);
    if (!session || session.ownerId !== input.ownerId) return { kind: 'not_found' };
    if (session.status === 'completed') return { kind: 'already_ended', session };
    if (session.version !== input.expectedVersion) {
      return { kind: 'version_conflict', currentVersion: session.version };
    }
    for (const [key, request] of this.requests) {
      if (
        request.sessionId === input.sessionId
        && request.status === 'claimed'
        && input.now.getTime() - request.updatedAt.getTime() >= STUDY_PARTNER_CLAIM_TIMEOUT_MS
      ) {
        this.requests.set(key, { ...request, status: 'failed', updatedAt: input.now });
      }
    }
    const active = [...this.requests.values()].some(
      (request) => request.sessionId === input.sessionId
        && (request.status === 'claimed' || request.status === 'accepted'),
    );
    if (active) return { kind: 'turn_in_progress' };
    const ended: StudyPartnerSessionRow = {
      ...session,
      status: 'completed',
      version: session.version + 1,
      updatedAt: input.now,
      completedAt: input.now,
    };
    this.sessions.set(input.sessionId, ended);
    return { kind: 'ended', session: ended };
  }

  async deleteOwnedSession(
    sessionId: string,
    ownerId: string,
    now: Date,
  ): Promise<DeleteStudyPartnerSessionResult> {
    const session = this.sessions.get(sessionId);
    if (!session || session.ownerId !== ownerId) return { kind: 'not_found' };
    const active = [...this.requests.values()].some(
      (request) => {
        if (request.sessionId !== sessionId) return false;
        const age = now.getTime() - request.updatedAt.getTime();
        return (request.status === 'claimed' && age < STUDY_PARTNER_CLAIM_TIMEOUT_MS)
          || (request.status === 'accepted' && age < STUDY_PARTNER_ACCEPTED_DELETE_PROTECTION_MS);
      },
    );
    if (active) return { kind: 'turn_in_progress' };
    this.sessions.delete(sessionId);
    this.turns.delete(sessionId);
    for (const [key, request] of this.requests) {
      if (request.sessionId === sessionId) this.requests.delete(key);
    }
    return { kind: 'deleted' };
  }
}
