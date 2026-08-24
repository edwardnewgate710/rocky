import type { Pool, PoolClient } from 'pg';
import type { Variant } from '@chess-platform/core';
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
  StudyPartnerTurnRow,
} from '../study-partner.js';
import {
  STUDY_PARTNER_ACCEPTED_DELETE_PROTECTION_MS,
  STUDY_PARTNER_CLAIM_TIMEOUT_MS,
} from '../study-partner.js';

interface SessionDbRow {
  id: string;
  owner_id: string;
  variant: string;
  initial_fen: string;
  current_fen: string;
  status: 'active' | 'completed';
  version: number;
  turn_count: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

interface TurnDbRow {
  id: string;
  session_id: string;
  turn_number: number;
  move: string;
  fen_before: string;
  fen_after: string;
  coaching: unknown;
  coaching_version: number;
  session_version: number;
  created_at: Date;
}

interface RequestDbRow {
  request_hash: string;
  status: 'claimed' | 'accepted' | 'succeeded' | 'failed';
  turn_id: string | null;
}

function sessionRow(row: SessionDbRow): StudyPartnerSessionRow {
  return {
    id: row.id,
    ownerId: row.owner_id,
    variant: row.variant as Variant,
    initialFen: row.initial_fen,
    currentFen: row.current_fen,
    status: row.status,
    version: row.version,
    turnCount: row.turn_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function turnRow(row: TurnDbRow): StudyPartnerTurnRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnNumber: row.turn_number,
    move: row.move,
    fenBefore: row.fen_before,
    fenAfter: row.fen_after,
    coaching: row.coaching,
    coachingVersion: row.coaching_version,
    sessionVersion: row.session_version,
    createdAt: row.created_at,
  };
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
}

const SESSION_COLUMNS = `id, owner_id, variant, initial_fen, current_fen, status,
  version, turn_count, created_at, updated_at, completed_at`;
const TURN_COLUMNS = `id, session_id, turn_number, move, fen_before, fen_after, coaching,
  coaching_version, session_version, created_at`;

export class PgStudyPartnerRepository implements StudyPartnerRepository {
  constructor(private readonly pool: Pool) {}

  async createSession(input: NewStudyPartnerSession): Promise<StudyPartnerSessionRow> {
    const result = await this.pool.query<SessionDbRow>(
      `INSERT INTO study_partner_sessions
         (id, owner_id, variant, initial_fen, current_fen, status, version, turn_count,
          created_at, updated_at, completed_at)
       VALUES ($1, $2, $3, $4, $4, 'active', 0, 0, $5, $5, NULL)
       RETURNING ${SESSION_COLUMNS}`,
      [input.id, input.ownerId, input.variant, input.initialFen, input.now],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Study Partner session insert returned no row');
    return sessionRow(row);
  }

  async findOwnedSession(sessionId: string, ownerId: string): Promise<StudyPartnerSessionDetail | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const sessionResult = await client.query<SessionDbRow>(
        `SELECT ${SESSION_COLUMNS} FROM study_partner_sessions WHERE id = $1 AND owner_id = $2`,
        [sessionId, ownerId],
      );
      const session = sessionResult.rows[0];
      if (!session) { await client.query('ROLLBACK'); return null; }
      const turns = await client.query<TurnDbRow>(
        `SELECT ${TURN_COLUMNS} FROM study_partner_turns
         WHERE session_id = $1 ORDER BY turn_number ASC`,
        [sessionId],
      );
      await client.query('COMMIT');
      return { session: sessionRow(session), turns: turns.rows.map(turnRow) };
    } catch (error: unknown) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimTurn(input: ClaimStudyPartnerTurn): Promise<ClaimStudyPartnerTurnResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const sessions = await client.query<SessionDbRow>(
        `SELECT ${SESSION_COLUMNS} FROM study_partner_sessions
         WHERE id = $1 AND owner_id = $2 FOR UPDATE`,
        [input.sessionId, input.ownerId],
      );
      const session = sessions.rows[0];
      if (!session) { await client.query('ROLLBACK'); return { kind: 'not_found' }; }

      await client.query(
        `UPDATE study_partner_turn_requests
            SET status = 'failed', updated_at = $2
          WHERE session_id = $1 AND status = 'claimed'
            AND updated_at <= $2 - ($3 * INTERVAL '1 millisecond')`,
        [input.sessionId, input.now, STUDY_PARTNER_CLAIM_TIMEOUT_MS],
      );

      const requests = await client.query<RequestDbRow>(
        `SELECT request_hash, status, turn_id FROM study_partner_turn_requests
         WHERE session_id = $1 AND idempotency_key = $2`,
        [input.sessionId, input.idempotencyKey],
      );
      const existing = requests.rows[0];
      if (existing) {
        if (existing.request_hash !== input.requestHash) {
          await client.query('ROLLBACK');
          return { kind: 'idempotency_conflict' };
        }
        if (existing.status === 'failed') {
          await client.query('ROLLBACK');
          return { kind: 'failed' };
        }
        if (existing.status !== 'succeeded' || !existing.turn_id) {
          await client.query('ROLLBACK');
          return { kind: 'in_progress' };
        }
        const replay = await client.query<TurnDbRow>(
          `SELECT ${TURN_COLUMNS} FROM study_partner_turns WHERE id = $1`,
          [existing.turn_id],
        );
        const turn = replay.rows[0];
        if (!turn) throw new Error('succeeded Study Partner request has no turn');
        await client.query('ROLLBACK');
        return { kind: 'replayed', turn: turnRow(turn) };
      }
      if (session.status !== 'active') { await client.query('ROLLBACK'); return { kind: 'inactive' }; }
      if (session.version !== input.expectedVersion) {
        await client.query('ROLLBACK');
        return { kind: 'version_conflict', currentVersion: session.version };
      }
      if (session.turn_count >= input.maxTurns) {
        await client.query('ROLLBACK');
        return { kind: 'turn_limit_reached' };
      }
      const active = await client.query(
        `SELECT 1 FROM study_partner_turn_requests
         WHERE session_id = $1 AND status IN ('claimed', 'accepted') LIMIT 1`,
        [input.sessionId],
      );
      if ((active.rowCount ?? 0) > 0) { await client.query('ROLLBACK'); return { kind: 'in_progress' }; }
      await client.query(
        `INSERT INTO study_partner_turn_requests
           (session_id, idempotency_key, request_hash, expected_version, status,
            turn_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'claimed', NULL, $5, $5)`,
        [input.sessionId, input.idempotencyKey, input.requestHash, input.expectedVersion, input.now],
      );
      await client.query('COMMIT');
      return { kind: 'claimed' };
    } catch (error: unknown) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async acceptTurn(ref: StudyPartnerTurnRequestRef): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE study_partner_turn_requests r
          SET status = 'accepted', updated_at = $5
        WHERE r.session_id = $1 AND r.idempotency_key = $2 AND r.request_hash = $3
          AND r.status = 'claimed'
          AND EXISTS (SELECT 1 FROM study_partner_sessions s
                       WHERE s.id = r.session_id AND s.owner_id = $4)
       RETURNING 1`,
      [ref.sessionId, ref.idempotencyKey, ref.requestHash, ref.ownerId, ref.now],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async failTurn(ref: StudyPartnerTurnRequestRef): Promise<void> {
    await this.pool.query(
      `UPDATE study_partner_turn_requests r
          SET status = 'failed', updated_at = $5
        WHERE r.session_id = $1 AND r.idempotency_key = $2 AND r.request_hash = $3
          AND r.status IN ('claimed', 'accepted')
          AND EXISTS (SELECT 1 FROM study_partner_sessions s
                       WHERE s.id = r.session_id AND s.owner_id = $4)`,
      [ref.sessionId, ref.idempotencyKey, ref.requestHash, ref.ownerId, ref.now],
    );
  }

  async commitTurn(input: CommitStudyPartnerTurn): Promise<CommitStudyPartnerTurnResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const sessions = await client.query<SessionDbRow>(
        `SELECT ${SESSION_COLUMNS} FROM study_partner_sessions
         WHERE id = $1 AND owner_id = $2 FOR UPDATE`,
        [input.sessionId, input.ownerId],
      );
      const session = sessions.rows[0];
      if (!session) { await client.query('ROLLBACK'); return { kind: 'not_found' }; }
      const requests = await client.query<RequestDbRow>(
        `SELECT request_hash, status, turn_id FROM study_partner_turn_requests
         WHERE session_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [input.sessionId, input.idempotencyKey],
      );
      const request = requests.rows[0];
      if (!request || request.request_hash !== input.requestHash || request.status !== 'accepted'
        || session.status !== 'active' || session.version !== input.expectedVersion
        || session.current_fen !== input.fenBefore) {
        await client.query('ROLLBACK');
        return { kind: 'conflict' };
      }
      const inserted = await client.query<TurnDbRow>(
        `INSERT INTO study_partner_turns
           (id, session_id, turn_number, move, fen_before, fen_after, coaching_version,
            coaching, session_version, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${TURN_COLUMNS}`,
        [input.turnId, input.sessionId, session.turn_count + 1, input.move, input.fenBefore,
          input.fenAfter, input.coachingVersion, input.coaching, session.version + 1, input.now],
      );
      await client.query(
        `UPDATE study_partner_sessions
            SET current_fen = $3, version = version + 1, turn_count = turn_count + 1, updated_at = $4
          WHERE id = $1 AND owner_id = $2`,
        [input.sessionId, input.ownerId, input.fenAfter, input.now],
      );
      await client.query(
        `UPDATE study_partner_turn_requests
            SET status = 'succeeded', turn_id = $3, updated_at = $4
          WHERE session_id = $1 AND idempotency_key = $2`,
        [input.sessionId, input.idempotencyKey, input.turnId, input.now],
      );
      await client.query('COMMIT');
      const row = inserted.rows[0];
      if (!row) throw new Error('Study Partner turn insert returned no row');
      return { kind: 'committed', turn: turnRow(row) };
    } catch (error: unknown) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async endSession(input: EndStudyPartnerSession): Promise<EndStudyPartnerSessionResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const sessions = await client.query<SessionDbRow>(
        `SELECT ${SESSION_COLUMNS} FROM study_partner_sessions
         WHERE id = $1 AND owner_id = $2 FOR UPDATE`,
        [input.sessionId, input.ownerId],
      );
      const session = sessions.rows[0];
      if (!session) { await client.query('ROLLBACK'); return { kind: 'not_found' }; }
      if (session.status === 'completed') {
        await client.query('ROLLBACK');
        return { kind: 'already_ended', session: sessionRow(session) };
      }
      if (session.version !== input.expectedVersion) {
        await client.query('ROLLBACK');
        return { kind: 'version_conflict', currentVersion: session.version };
      }
      const active = await client.query(
        `SELECT 1 FROM study_partner_turn_requests
         WHERE session_id = $1 AND status IN ('claimed', 'accepted') LIMIT 1`,
        [input.sessionId],
      );
      if ((active.rowCount ?? 0) > 0) {
        await client.query('ROLLBACK');
        return { kind: 'turn_in_progress' };
      }
      const ended = await client.query<SessionDbRow>(
        `UPDATE study_partner_sessions
            SET status = 'completed', completed_at = $3, updated_at = $3, version = version + 1
          WHERE id = $1 AND owner_id = $2
        RETURNING ${SESSION_COLUMNS}`,
        [input.sessionId, input.ownerId, input.now],
      );
      await client.query('COMMIT');
      const row = ended.rows[0];
      if (!row) throw new Error('Study Partner end returned no row');
      return { kind: 'ended', session: sessionRow(row) };
    } catch (error: unknown) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteOwnedSession(
    sessionId: string,
    ownerId: string,
    now: Date,
  ): Promise<DeleteStudyPartnerSessionResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const session = await client.query(
        `SELECT 1 FROM study_partner_sessions WHERE id = $1 AND owner_id = $2 FOR UPDATE`,
        [sessionId, ownerId],
      );
      if ((session.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        return { kind: 'not_found' };
      }
      // Serialize a stale pre-charge claim against acceptTurn. If acceptance won first, its fresh
      // accepted timestamp is protected below; if this update wins, acceptTurn can no longer charge.
      await client.query(
        `UPDATE study_partner_turn_requests
            SET status = 'failed', updated_at = $2
          WHERE session_id = $1 AND status = 'claimed'
            AND updated_at <= $2 - ($3 * INTERVAL '1 millisecond')`,
        [sessionId, now, STUDY_PARTNER_CLAIM_TIMEOUT_MS],
      );
      const active = await client.query(
        `SELECT 1 FROM study_partner_turn_requests
         WHERE session_id = $1
           AND (status = 'claimed'
             OR (status = 'accepted'
                 AND updated_at > $2 - ($3 * INTERVAL '1 millisecond')))
         LIMIT 1`,
        [sessionId, now, STUDY_PARTNER_ACCEPTED_DELETE_PROTECTION_MS],
      );
      if ((active.rowCount ?? 0) > 0) {
        await client.query('ROLLBACK');
        return { kind: 'turn_in_progress' };
      }
      await client.query(
        `DELETE FROM study_partner_sessions WHERE id = $1 AND owner_id = $2`,
        [sessionId, ownerId],
      );
      await client.query('COMMIT');
      return { kind: 'deleted' };
    } catch (error: unknown) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
