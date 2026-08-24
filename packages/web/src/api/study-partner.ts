import type { Execute } from './client.js';
import type {
  StudyPartnerSession,
  SubmitStudyPartnerTurnResponse,
} from './models.js';

const STUDY_PARTNER_PERMANENT_STATUSES: readonly number[] = [503];
const STUDY_PARTNER_TURN_PERMANENT_STATUSES: readonly number[] = [429, 503];

/** Typed client for the private, server-authoritative Study Partner v1 lifecycle. */
export class StudyPartnerApi {
  constructor(private readonly execute: Execute) {}

  create(body: { readonly variant: 'standard'; readonly initialFen: string }): Promise<StudyPartnerSession> {
    return this.execute<StudyPartnerSession>({
      method: 'POST',
      path: '/v1/study-partner/sessions',
      auth: true,
      body,
      permanentStatuses: STUDY_PARTNER_PERMANENT_STATUSES,
    });
  }

  byId(id: string): Promise<StudyPartnerSession> {
    return this.execute<StudyPartnerSession>({
      method: 'GET',
      path: `/v1/study-partner/sessions/${encodeURIComponent(id)}`,
      auth: true,
      permanentStatuses: STUDY_PARTNER_PERMANENT_STATUSES,
    });
  }

  submitTurn(
    id: string,
    body: { readonly move: string; readonly expectedVersion: number },
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<SubmitStudyPartnerTurnResponse> {
    return this.execute<SubmitStudyPartnerTurnResponse>({
      method: 'POST',
      path: `/v1/study-partner/sessions/${encodeURIComponent(id)}/turns`,
      auth: true,
      body,
      headers: { 'Idempotency-Key': idempotencyKey },
      idempotent: true,
      permanentStatuses: STUDY_PARTNER_TURN_PERMANENT_STATUSES,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  end(id: string, expectedVersion: number): Promise<StudyPartnerSession> {
    return this.execute<StudyPartnerSession>({
      method: 'POST',
      path: `/v1/study-partner/sessions/${encodeURIComponent(id)}/end`,
      auth: true,
      body: { expectedVersion },
      idempotent: true,
      permanentStatuses: STUDY_PARTNER_PERMANENT_STATUSES,
    });
  }

  delete(id: string): Promise<void> {
    return this.execute<void>({
      method: 'DELETE',
      path: `/v1/study-partner/sessions/${encodeURIComponent(id)}`,
      auth: true,
      idempotent: false,
      permanentStatuses: STUDY_PARTNER_PERMANENT_STATUSES,
    });
  }
}
