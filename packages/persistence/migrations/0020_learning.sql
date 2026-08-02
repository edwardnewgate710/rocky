-- Migration 0020: Learning & Courses system tables (courses, lessons, steps, progress)

CREATE TABLE learning_courses (
  id          UUID        NOT NULL PRIMARY KEY,
  author_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug        TEXT        NOT NULL,
  title       TEXT        NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  difficulty  TEXT        NOT NULL CHECK (difficulty IN ('beginner', 'intermediate', 'advanced')),
  published   BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  deleted_at  TIMESTAMPTZ
);

-- Active course slugs must be unique across the platform.
CREATE UNIQUE INDEX learning_courses_slug_idx ON learning_courses (slug) WHERE deleted_at IS NULL;

-- Covers author_id FK for cascading user deletions and filtering courses by author.
CREATE INDEX learning_courses_author_id_idx ON learning_courses (author_id);

CREATE TABLE learning_lessons (
  id          UUID        NOT NULL PRIMARY KEY,
  course_id   UUID        NOT NULL REFERENCES learning_courses(id) ON DELETE CASCADE,
  title       TEXT        NOT NULL,
  order_index INTEGER     NOT NULL,
  deleted_at  TIMESTAMPTZ
);

-- Active lessons within a course must have dense, unique 0-indexed orderIndex positions.
CREATE UNIQUE INDEX learning_lessons_course_id_order_index_idx
  ON learning_lessons (course_id, order_index) WHERE deleted_at IS NULL;

-- Covers course_id FK for cascading course deletions.
-- Note: A dedicated full index is required because learning_lessons_course_id_order_index_idx is partial
-- (WHERE deleted_at IS NULL) and therefore does not cover tombstoned (deleted) rows during cascading deletes.
CREATE INDEX learning_lessons_course_id_idx ON learning_lessons (course_id);

CREATE TABLE learning_steps (
  id            UUID        NOT NULL PRIMARY KEY,
  lesson_id     UUID        NOT NULL REFERENCES learning_lessons(id) ON DELETE CASCADE,
  order_index   INTEGER     NOT NULL,
  kind          TEXT        NOT NULL CHECK (kind IN ('text', 'move', 'quiz')),
  prose         TEXT,
  fen           TEXT,
  expected_san  TEXT,
  hint          TEXT,
  question      TEXT,
  options       JSONB,
  correct_index INTEGER,
  deleted_at    TIMESTAMPTZ
);

-- Active steps within a lesson must have dense, unique 0-indexed orderIndex positions.
CREATE UNIQUE INDEX learning_steps_lesson_id_order_index_idx
  ON learning_steps (lesson_id, order_index) WHERE deleted_at IS NULL;

-- Covers lesson_id FK for cascading lesson deletions.
-- Note: A dedicated full index is required because learning_steps_lesson_id_order_index_idx is partial
-- (WHERE deleted_at IS NULL) and therefore does not cover tombstoned (deleted) rows during cascading deletes.
CREATE INDEX learning_steps_lesson_id_idx ON learning_steps (lesson_id);

CREATE TABLE learning_progress (
  player_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id    UUID        NOT NULL REFERENCES learning_courses(id) ON DELETE CASCADE,
  lesson_id    UUID        NOT NULL REFERENCES learning_lessons(id) ON DELETE CASCADE,
  step_id      UUID        NOT NULL REFERENCES learning_steps(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ,
  attempts     INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, step_id)
);

-- Covers course_id FK lookups and cascading course deletions.
CREATE INDEX learning_progress_course_id_idx ON learning_progress (course_id);

-- Covers lesson_id FK for cascading lesson deletions.
CREATE INDEX learning_progress_lesson_id_idx ON learning_progress (lesson_id);

-- Covers step_id FK for cascading step deletions (since primary key (player_id, step_id) leads with player_id).
CREATE INDEX learning_progress_step_id_idx ON learning_progress (step_id);
