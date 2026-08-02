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
