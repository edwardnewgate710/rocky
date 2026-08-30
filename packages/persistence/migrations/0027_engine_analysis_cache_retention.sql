-- Retention support for the durable engine analysis cache (ADR-0138).
--
-- ADR-0135 §7 made retention a precondition of wiring this cache to production: the table has no
-- TTL and no eviction, which is acceptable for a table nothing writes to and not acceptable once
-- production composes it. The sweeper deletes by age, so it needs to find the oldest rows without
-- reading the whole table.
--
-- The index is on `updated_at` alone. That is the retention predicate's only column, and the
-- sweeper reads it in ascending order, so a plain btree serves both the range scan and the ORDER BY.
--
-- Created transactionally rather than through the `migrate:online-index` directive. CREATE INDEX
-- takes ACCESS EXCLUSIVE for the duration of the build, which is what makes an online index worth
-- its extra machinery on a live table — but this table is empty in every deployment: it was shipped
-- by 0026 and, per ADR-0135 §7, no code has ever composed the adapter that writes to it. Building
-- the index on zero rows is immediate, so the concurrent path would buy nothing and cost the
-- two-phase pending state it needs to be interruptible.
CREATE INDEX engine_analysis_cache_updated_at_idx
    ON engine_analysis_cache (updated_at);
