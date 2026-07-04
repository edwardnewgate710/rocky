/**
 * @packageDocumentation
 * Postgres-backed {@link EventStore}. Appends are transactional and rely on the
 * `(game_id, seq)` primary key for optimistic concurrency: a losing race becomes
 * a unique-violation surfaced as {@link ConcurrencyError}.
 */

import type { Pool, PoolClient } from 'pg';
import type { GameEvent } from '@chess-platform/game';
import {
  CURRENT_EVENT_VERSION,
  upcast,
  type EventStore,
  type StoredEvent,
} from '../event-store';
import { ConcurrencyError, PersistenceError } from '../errors';

interface EventRow {
  game_id: string;
  seq: number;
  type: string;
  event_version: number;
  payload: unknown;
  server_ts: Date;
}

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;
}

function toStored(row: EventRow): StoredEvent {
  return {
    gameId: row.game_id,
    seq: Number(row.seq),
    version: Number(row.event_version),
    event: upcast(row.type, Number(row.event_version), row.payload),
    serverTs: row.server_ts.getTime(),
  };
}

export class PostgresEventStore implements EventStore {
  constructor(private readonly pool: Pool) {}

  private async headSeq(client: PoolClient, gameId: string): Promise<number> {
    const res = await client.query<{ head: string }>(
      'SELECT COALESCE(MAX(seq), -1)::text AS head FROM game_events WHERE game_id = $1',
      [gameId],
    );
    return parseInt(res.rows[0]!.head, 10);
  }

  async append(gameId: string, expectedSeq: number, events: readonly GameEvent[]): Promise<number> {
    if (events.length === 0) return expectedSeq;
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      const head = await this.headSeq(client, gameId);
      if (head !== expectedSeq) throw new ConcurrencyError(gameId, expectedSeq, head);
      if (head === -1 && events[0]!.type !== 'GameCreated') {
        throw new PersistenceError('first stored event must be GameCreated');
      }
      let seq = head;
      for (const event of events) {
        seq += 1;
        await client.query(
          `INSERT INTO game_events (game_id, seq, type, event_version, payload)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [gameId, seq, event.type, CURRENT_EVENT_VERSION, JSON.stringify(event)],
        );
      }
      await client.query('COMMIT');
      committed = true;
      return seq;
    } catch (err) {
      if (!committed) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* ignore rollback failure */
        }
      }
      if (isUniqueViolation(err)) throw new ConcurrencyError(gameId, expectedSeq);
      throw err;
    } finally {
      client.release();
    }
  }

  async load(gameId: string): Promise<StoredEvent[]> {
    const res = await this.pool.query<EventRow>(
      `SELECT game_id, seq, type, event_version, payload, server_ts
       FROM game_events WHERE game_id = $1 ORDER BY seq ASC`,
      [gameId],
    );
    return res.rows.map(toStored);
  }

  async loadSince(gameId: string, afterSeq: number): Promise<StoredEvent[]> {
    const res = await this.pool.query<EventRow>(
      `SELECT game_id, seq, type, event_version, payload, server_ts
       FROM game_events WHERE game_id = $1 AND seq > $2 ORDER BY seq ASC`,
      [gameId, afterSeq],
    );
    return res.rows.map(toStored);
  }

  async exists(gameId: string): Promise<boolean> {
    const res = await this.pool.query(
      'SELECT 1 FROM game_events WHERE game_id = $1 LIMIT 1',
      [gameId],
    );
    return res.rowCount !== null && res.rowCount > 0;
  }
}
