/**
 * @packageDocumentation
 * The audit-log port — a repository interface extension owned by the `api`
 * package (it maps onto the `audit_log` table defined in the persistence
 * migration, but the write-side contract lives with the service that produces
 * the events). Every security-relevant action (register, login, token refresh,
 * refresh-reuse detection, logout, role grants) records an entry so the trail
 * can be joined to request/trace ids for forensics.
 */

/** One audit record. `at` is milliseconds since the epoch. */
export interface AuditEntry {
  /** The acting user, or null for anonymous / system actions. */
  readonly actorId: string | null;
  /** Verb, e.g. `auth.login`, `auth.refresh.reuse`, `roles.grant`. */
  readonly action: string;
  /** Affected resource identifier, if any. */
  readonly target?: string | null;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly requestId?: string | null;
  readonly traceId?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly at: number;
}

/** Append-only sink for {@link AuditEntry} records. */
export interface AuditRepository {
  record(entry: AuditEntry): Promise<void>;
}
