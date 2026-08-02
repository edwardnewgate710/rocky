/**
 * The two Postgres error codes the social and messaging adapters have to answer for, in one place
 * so a raw `'23503'` never has to be recognized on sight at a call site.
 *
 * Both matter for the same reason: they are the database refusing user-controlled input, and an
 * unrecognized database error becomes a 500. A player id that is a well-formed UUID but belongs to
 * nobody is not a server fault — it is a request about someone who does not exist, and it deserves
 * a 404 rather than an internal error.
 */

function sqlstate(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** SQLSTATE 23505 — unique_violation. */
export function isUniqueViolation(err: unknown): boolean {
  return sqlstate(err) === '23505';
}

/** SQLSTATE 23503 — foreign_key_violation. Here it always means "that player does not exist". */
export function isForeignKeyViolation(err: unknown): boolean {
  return sqlstate(err) === '23503';
}

/**
 * SQLSTATE 22P02 — invalid_text_representation. Raised when a value that is not a UUID is compared
 * against a `uuid` column, which is what a malformed id from a path parameter does.
 *
 * Routes are supposed to stop these at the edge with `parseUuid`, and that remains the right place
 * — a 422 says more than a 404. But a repository that answers 500 whenever a route forgets is a
 * repository that turns one missing call into an outage, so an id that cannot name any row is
 * treated here as naming no row.
 */
export function isInvalidTextRepresentation(err: unknown): boolean {
  return sqlstate(err) === '22P02';
}
