# ADR-0053 — Postgres Full-Text Search Adapter (PgSearchRepository)

| Field      | Value                           |
|------------|---------------------------------|
| **Status** | Accepted                        |
| **Date**   | 2026-07-24                      |
| **Scope**  | `@chess-platform/persistence` (M11) |

---

## Context

Milestone 11 Increment 4 (ADR-0052) updated the `SearchRepository` port in `@chess-platform/search` to be asynchronous, enabling database-backed search repository adapters.

Keyword search across platform entities (games, players, tournaments, studies) requires a durable persistence adapter backed by PostgreSQL full-text search capabilities, complementing the pure in-memory reference implementation (`InMemorySearchRepository`).

## Decision

Introduce `PgSearchRepository` in `@chess-platform/persistence` (`@chess-platform/persistence/pg` subpath) implementing the async `SearchRepository` port:

1. **Schema Migration (`0013_search_documents.sql`)**:
   - `search_documents` table with `id` (`TEXT NOT NULL PRIMARY KEY`), `text` (`TEXT NOT NULL`), `fields` (`JSONB NOT NULL DEFAULT '{}'::jsonb`), and a stored generated column `tsv` (`tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED`).
   - GIN indexes on `tsv` (`search_documents_tsv_idx`) and `fields` (`search_documents_fields_idx`).

2. **Query Translation & Parameter Security**:
   - Term queries are translated via `plainto_tsquery('simple', $N)` and phrases via `phraseto_tsquery('simple', $N)`, combined with `&&`.
   - Field values (and keys) are canonicalized to lowercase at index time, so metadata filters match case-insensitively via jsonb **containment** — `fields @> '{"k":"v"}'` for positive filters and `NOT (fields @> '{"k":"v"}')` for negated filters (`-field:value`). Containment is served by the `search_documents_fields_idx` GIN index (unlike a `lower(fields->>'k') = lower($v)` functional predicate, which cannot use it); `NOT (@>)` also yields the intended negation semantics (an absent field or a different value is a hit).
   - All user-controlled SQL inputs (field names, field values, terms, and phrases) are strictly bound parameters ($1, $2, ...); column names and SQL operators are fixed literals.
   - Scoring uses `ts_rank(tsv, (...))` when a text query is present, defaulting to `0` for filter-only/empty queries (ordered by `score DESC, id ASC`).
   - Total matching count is calculated via `SELECT count(*)::text AS count` before appending `LIMIT` and `OFFSET` pagination parameters.

3. **Full-Text Matching Semantics**:
   - Postgres `simple` configuration lowercases and tokenizes on non-word characters without stemming or stop-word removal.
   - While matching semantics differ slightly from the pure in-memory `search` ranker (e.g. ranking scores vs phrase bonus math), adapter-appropriate matching is explicitly permitted under the `SearchRepository` port contract.

4. **Deferred**:
   - `pgvector` semantic vector search adapter and REST/GraphQL API integration are deferred to later M11 increments.

## Consequences

- Durable keyword search over indexed documents with database persistence and transactional batch indexing (`indexAll`).
- Parameterized SQL execution guarantees immunity to SQL injection.
- Zero dependency changes required in `@chess-platform/search` or consumer packages.
