# ADR-0072 — Structured Courses & Interactive Lessons System (Domain, Postgres Adapter & REST API)

| Field      | Value                                                                             |
|------------|-----------------------------------------------------------------------------------|
| **Status** | Accepted                                                                          |
| **Date**   | 2026-08-02                                                                        |
| **Scope**  | `@chess-platform/learning`, `@chess-platform/persistence`, `@chess-platform/api`, `services/gateway` |

---

## Context

Milestone 10 ("Social & learning") increment 7 requires a structured courses and interactive lessons system spanning the pure domain core (`@chess-platform/learning`), Postgres persistence layer (`@chess-platform/persistence`), and REST API (`@chess-platform/api`).

Key architectural requirements:
1. Pure, dependency-free domain core (`@chess-platform/learning`) defining courses, lessons, lesson steps (text, move, quiz), attempt results, progress summaries, ordering, and pagination.
2. Reuse of the `PositionReader` port from `@chess-platform/studies` for validating move step `expectedSan` move legality at authoring time.
3. Strict slug validation and normalization (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`).
4. Dense, contiguous 0-based ordering for lessons within a course and steps within a lesson, with soft deletion compacting active items.
5. Postgres adapter (`PgLearningRepository`) enforcing 8 domain invariants, using course-keyed advisory locks (`pg_advisory_xact_lock`) before row locks to prevent transaction deadlocks, negative-index reordering shifts to avoid partial unique index collisions, and single atomic SQL statement attempt recording (`INSERT ... ON CONFLICT DO UPDATE SET attempts = ..., completed_at = COALESCE(...)`).
6. 23 REST API endpoints under `/v1/courses`, `/v1/lessons`, `/v1/steps` with OpenAPI documentation, strict UUID parameter validation, route-level input validation, and `LEARNING_ENABLED` opt-in feature flag.

---

## Decisions

### 1. Domain Separation & Step Discriminators

The `@chess-platform/learning` domain model structures learning content into a 3-tier hierarchy:
- `Course`: high-level curriculum (slug, title, description, difficulty, published state, authorId).
- `Lesson`: ordered chapter within a course (title, orderIndex).
- `LessonStep`: individual interactive learning step (orderIndex, kind: `'text' | 'move' | 'quiz'`).

Step types are discriminated unions:
- `TextLessonStep`: `prose`
- `MoveLessonStep`: `fen`, `expectedSan`, `hint` (optional)
- `QuizLessonStep`: `question`, `options` (2–6 strings), `correctIndex` (0-based)

### 2. Move Legality at Authoring Time via `PositionReader`

To prevent bad moves or illegal FENs from being authored, step creation and updates enforce move legality against the board state by reusing `@chess-platform/studies`'s `PositionReader` port (`resolveSan(positionReader, fen, expectedSan)`). Invalid moves throw `LearningRuleError('invalid_move')`.

### 3. Postgres Schema & Foreign Key Indexing

Four tables store learning state:
- `learning_courses`: `slug` UNIQUE INDEX `WHERE deleted_at IS NULL`.
- `learning_lessons`: `(course_id, order_index)` UNIQUE INDEX `WHERE deleted_at IS NULL`. Dedicated full index `learning_lessons_course_id_idx` covers cascading user/course deletions (since the composite unique index is partial).
- `learning_steps`: `(lesson_id, order_index)` UNIQUE INDEX `WHERE deleted_at IS NULL`. Dedicated full index `learning_steps_lesson_id_idx` covers cascading lesson deletions.
- `learning_progress`: primary key `(player_id, step_id)`. Dedicated indexes on `course_id`, `lesson_id`, and `step_id` cover FK lookups and cascading deletions.

### 4. Concurrency & Transactional Discipline

- Advisory locking: Any transaction modifying course content or children acquires a course-level advisory lock (`pg_advisory_xact_lock(hashtextextended('course:' || $1, 0))`) before reading or modifying rows `FOR UPDATE`.
- Dense order index reordering: To avoid partial unique index collisions (`WHERE deleted_at IS NULL`) during reorder operations, active items are shifted to negative indices (`-1 - i`) in step 1, then updated to final contiguous `0..N-1` values in step 2.
- Single atomic statement attempt recording:
  ```sql
  INSERT INTO learning_progress (player_id, course_id, lesson_id, step_id, attempts, completed_at)
  VALUES ($1, $2, $3, $4, 1, $5)
  ON CONFLICT (player_id, step_id) DO UPDATE SET
    attempts = CASE
      WHEN learning_progress.completed_at IS NOT NULL AND EXCLUDED.completed_at IS NOT NULL THEN learning_progress.attempts
      ELSE learning_progress.attempts + 1
    END,
    completed_at = COALESCE(learning_progress.completed_at, EXCLUDED.completed_at)
  RETURNING attempts, completed_at;
  ```
  This handles first attempts, wrong attempts, step completion, and idempotent re-submissions of correct answers after completion in one atomic SQL statement.

### 4a. The adapter has to actually use the database

`listCourses` was first written the way the in-memory adapter works: read every row, then filter,
sort and slice in JavaScript. Against a `Map` that is the only thing you can do. Against Postgres it
transfers the whole course table on every listing — page one included — and grows with the catalogue
rather than with the page. It is correct and it is not a query.

Filtering, ordering and pagination are now SQL. Two details in it are load-bearing:

- **The visibility rule is a `WHERE` condition, not a post-filter.** "Unpublished courses are visible
  only to their author" applied after paging would let an unpublished course occupy a slot on a page
  and then vanish from it, changing the page size a caller sees and leaking that *something* was
  there.
- **The search term is escaped before it reaches `ILIKE`.** `%` and `_` are wildcards; a term
  containing one is a term, not a pattern the caller gets to inject into someone else's query.

`ORDER BY created_at DESC, id ASC` is `compareCourses`, and the `id` tie-break agrees because `uuid`
compares byte-wise, which coincides with code-point order on canonical lowercase UUID text
(ADR-0067 §2). The two must be changed together.

### 4b. No `SELECT *`, no `RETURNING *`

Every query names its columns. `client.query<CourseRow>(...)` is an **assertion**, not a check — the
row type is imposed on whatever the driver returned. With `*`, a column renamed or dropped by a
later migration produces `undefined` at runtime and nothing fails to compile. Naming the columns
makes the assertion something a reader can verify against the migration in one glance, which is why
the three adapters before this one contain zero of either.

### 5. REST API & Feature Flag Wiring

- Endpoints follow strict REST standards under `/v1/courses`, `/v1/lessons`, and `/v1/steps`.
- UUID parameters are validated using `parseUuid`. Client-supplied entity IDs in request bodies are rejected in favor of `deps.ids.next()`.
- Feature flag `LEARNING_ENABLED === '1'` gates production instantiation of `PgLearningRepository`. When absent, endpoints respond 503 Service Unavailable.

---

## Consequences

- Domain package `@chess-platform/learning` remains dependency-free and 100% covered by unit tests.
- Postgres adapter handles high-concurrency attempt submissions without deadlocks or race conditions.
- API is fully documented in OpenAPI spec (`openapi.json`) with zero contract drift.
