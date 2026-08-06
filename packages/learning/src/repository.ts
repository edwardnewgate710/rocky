import type { PositionReader } from '@chess-platform/studies';
import type {
  AttemptResult,
  Course,
  CourseDifficulty,
  CourseProgressSummary,
  CreateStepInput,
  Lesson,
  LessonStep,
  Progress,
  StepAttemptInput,
  UpdateStepInput,
} from './model';
import type { Page, PageOptions } from './pagination';

/**
 * Storage-agnostic port for courses, lessons, steps, and learner progress.
 *
 * Every implementation owes all of these invariants:
 *
 * 1. Only the author may edit a course, its lessons or its steps. A course that is not `published`
 *    is invisible to everyone except its author and reads as `not_found` — `not_authorized` is only
 *    for something the actor can see but may not do.
 * 2. Slugs are unique, normalized (lowercase, trimmed), non-empty, and constrained to a documented
 *    character set (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`). Bad input is rejected; it is never silently rewritten.
 * 3. `orderIndex` is dense and stable for lessons within a course and steps within a lesson. Reordering
 *    yields a contiguous 0-indexed sequence and two siblings can never share an index. In Postgres,
 *    reordering shifts items to negative indices first then to final values to comply with partial
 *    unique indexes on active rows. Deleting a lesson/step compacts remaining indices downward.
 * 4. A `'move'` step's `expectedSan` must be legal from its `fen` at authoring time (when created or updated),
 *    validated via `PositionReader` / `resolveSan`.
 * 5. Submitting an attempt is idempotent per (player, step): re-submitting a correct answer does not move
 *    `completedAt` and does not inflate `attempts`. `attempts` counts real attempts and never decreases.
 * 6. A quiz answer index outside the options range (0 <= selectedIndex < options.length) is rejected
 *    with `invalid_input`, not scored as wrong.
 * 7. Course progress is derived: completed steps / total steps is computed from progress rows against
 *    active steps in the course.
 * 8. Deleting a course, lesson or step is a tombstone (`deletedAt` set). A tombstoned entity cannot be
 *    edited or deleted again (`invalid_transition`). Deleting a step does not delete a learner's history.
 */
export interface LearningRepository {
  createCourse(
    id: string,
    authorId: string,
    slug: string,
    title: string,
    description: string,
    difficulty: CourseDifficulty,
    published?: boolean,
    at?: Date
  ): Promise<Course>;

  getCourse(courseId: string, actorId?: string): Promise<Course>;

  getCourseBySlug(slug: string, actorId?: string): Promise<Course>;

  updateCourse(
    courseId: string,
    actorId: string,
    updates: {
      slug?: string;
      title?: string;
      description?: string;
      difficulty?: CourseDifficulty;
      published?: boolean;
    },
    at?: Date
  ): Promise<Course>;

  deleteCourse(courseId: string, actorId: string, at?: Date): Promise<Course>;

  listCourses(
    actorId?: string,
    options?: PageOptions & {
      authorId?: string;
      difficulty?: CourseDifficulty;
      search?: string;
    }
  ): Promise<Page<Course>>;

  // Lesson management
  createLesson(
    id: string,
    courseId: string,
    actorId: string,
    title: string,
    at?: Date
  ): Promise<Lesson>;

  getLesson(lessonId: string, actorId?: string): Promise<Lesson>;

  listLessons(courseId: string, actorId?: string): Promise<readonly Lesson[]>;

  updateLesson(
    lessonId: string,
    actorId: string,
    updates: { title?: string },
    at?: Date
  ): Promise<Lesson>;

  reorderLessons(
    courseId: string,
    actorId: string,
    lessonIds: readonly string[],
    at?: Date
  ): Promise<readonly Lesson[]>;

  deleteLesson(lessonId: string, actorId: string, at?: Date): Promise<Lesson>;

  // Step management
  createStep(
    id: string,
    lessonId: string,
    actorId: string,
    input: CreateStepInput,
    positionReader: PositionReader,
    at?: Date
  ): Promise<LessonStep>;

  getStep(stepId: string, actorId?: string): Promise<LessonStep>;

  listSteps(lessonId: string, actorId?: string): Promise<readonly LessonStep[]>;

  /**
   * The same reads as `getStep` / `listSteps`, returning the owning course alongside the steps.
   *
   * Both plain forms already resolve lesson → course to enforce invariant 1, then discard the course.
   * A caller that needs to know who the author is — the learner-scoped step projection in
   * `packages/api` (ADR-0095) is the one that does — otherwise re-resolves the same two rows after
   * the fact, doubling the query count on the routes a lesson page calls. These return what was
   * already loaded.
   *
   * Visibility, ordering and `not_found` behaviour are identical to the plain forms. The course is
   * returned as data, not as a permission: deciding what an actor may see with it stays with the
   * caller.
   */
  getStepWithCourse(
    stepId: string,
    actorId?: string
  ): Promise<{ readonly step: LessonStep; readonly course: Course }>;

  listStepsWithCourse(
    lessonId: string,
    actorId?: string
  ): Promise<{ readonly steps: readonly LessonStep[]; readonly course: Course }>;

  updateStep(
    stepId: string,
    actorId: string,
    updates: UpdateStepInput,
    positionReader: PositionReader,
    at?: Date
  ): Promise<LessonStep>;

  reorderSteps(
    lessonId: string,
    actorId: string,
    stepIds: readonly string[],
    at?: Date
  ): Promise<readonly LessonStep[]>;

  deleteStep(stepId: string, actorId: string, at?: Date): Promise<LessonStep>;

  // Progress & Attempts
  submitAttempt(
    playerId: string,
    stepId: string,
    attempt: StepAttemptInput,
    at?: Date
  ): Promise<AttemptResult>;

  getProgressSummary(playerId: string, courseId: string): Promise<CourseProgressSummary>;

  listProgress(playerId: string, courseId: string): Promise<readonly Progress[]>;
}
