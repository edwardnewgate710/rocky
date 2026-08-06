import type { PositionReader } from '@chess-platform/studies';
import { resolveSan } from '@chess-platform/studies';
import { LearningRuleError } from './errors';
import type {
  AttemptResult,
  Course,
  CourseDifficulty,
  CourseProgressSummary,
  CreateStepInput,
  Lesson,
  LessonStep,
  MoveLessonStep,
  Progress,
  QuizLessonStep,
  StepAttemptInput,
  UpdateStepInput,
} from './model';
import { validateAndNormalizeSlug } from './model';
import { compareCourses, compareLessons, compareProgress, compareSteps } from './ordering';
import type { Page, PageOptions } from './pagination';
import { paginate } from './pagination';
import type { LearningRepository } from './repository';

function bareSan(san: string): string {
  return san.replace(/[+#!?]+$/, '').replace(/^0-0-0$/, 'O-O-O').replace(/^0-0$/, 'O-O');
}

export class InMemoryLearningRepository implements LearningRepository {
  private readonly courses = new Map<string, Course>();
  private readonly lessons = new Map<string, Lesson>();
  private readonly steps = new Map<string, LessonStep>();
  private readonly progress = new Map<string, Progress>();

  async createCourse(
    id: string,
    authorId: string,
    slug: string,
    title: string,
    description: string,
    difficulty: CourseDifficulty,
    published = false,
    at = new Date()
  ): Promise<Course> {
    const validSlug = validateAndNormalizeSlug(slug);

    if (!title.trim()) {
      throw new LearningRuleError('invalid_input', 'Course title cannot be empty');
    }

    if (this.courses.has(id)) {
      throw new LearningRuleError('invalid_input', `Course with id '${id}' already exists`);
    }

    for (const c of this.courses.values()) {
      if (!c.deletedAt && c.slug === validSlug) {
        throw new LearningRuleError('duplicate_slug', `Slug '${validSlug}' is already taken`);
      }
    }

    const course: Course = {
      id,
      authorId,
      slug: validSlug,
      title: title.trim(),
      description: description.trim(),
      difficulty,
      published,
      createdAt: at,
      updatedAt: at,
    };

    this.courses.set(id, course);
    return course;
  }

  async getCourse(courseId: string, actorId?: string): Promise<Course> {
    const course = this.courses.get(courseId);
    if (!course || course.deletedAt) {
      throw new LearningRuleError('not_found', `Course '${courseId}' not found`);
    }

    if (!course.published && course.authorId !== actorId) {
      throw new LearningRuleError('not_found', `Course '${courseId}' not found`);
    }

    return course;
  }

  async getCourseBySlug(slug: string, actorId?: string): Promise<Course> {
    const validSlug = validateAndNormalizeSlug(slug);

    for (const course of this.courses.values()) {
      if (!course.deletedAt && course.slug === validSlug) {
        if (!course.published && course.authorId !== actorId) {
          throw new LearningRuleError('not_found', `Course with slug '${validSlug}' not found`);
        }
        return course;
      }
    }

    throw new LearningRuleError('not_found', `Course with slug '${validSlug}' not found`);
  }

  async updateCourse(
    courseId: string,
    actorId: string,
    updates: {
      slug?: string;
      title?: string;
      description?: string;
      difficulty?: CourseDifficulty;
      published?: boolean;
    },
    at = new Date()
  ): Promise<Course> {
    const course = await this.getCourse(courseId, actorId);

    if (course.authorId !== actorId) {
      throw new LearningRuleError('not_authorized', 'Only the course author may update the course');
    }

    let newSlug = course.slug;
    if (updates.slug !== undefined) {
      newSlug = validateAndNormalizeSlug(updates.slug);
      for (const c of this.courses.values()) {
        if (!c.deletedAt && c.id !== courseId && c.slug === newSlug) {
          throw new LearningRuleError('duplicate_slug', `Slug '${newSlug}' is already taken`);
        }
      }
    }

    let newTitle = course.title;
    if (updates.title !== undefined) {
      if (!updates.title.trim()) {
        throw new LearningRuleError('invalid_input', 'Course title cannot be empty');
      }
      newTitle = updates.title.trim();
    }

    const updated: Course = {
      ...course,
      slug: newSlug,
      title: newTitle,
      description: updates.description !== undefined ? updates.description.trim() : course.description,
      difficulty: updates.difficulty ?? course.difficulty,
      published: updates.published ?? course.published,
      updatedAt: at,
    };

    this.courses.set(courseId, updated);
    return updated;
  }

  async deleteCourse(courseId: string, actorId: string, at = new Date()): Promise<Course> {
    const course = this.courses.get(courseId);
    if (!course || course.deletedAt) {
      throw new LearningRuleError('not_found', `Course '${courseId}' not found`);
    }

    if (course.authorId !== actorId) {
      throw new LearningRuleError('not_authorized', 'Only the course author may delete the course');
    }

    const tombstoned: Course = {
      ...course,
      deletedAt: at,
      updatedAt: at,
    };

    this.courses.set(courseId, tombstoned);
    return tombstoned;
  }

  async listCourses(
    actorId?: string,
    options?: PageOptions & {
      authorId?: string;
      difficulty?: CourseDifficulty;
      search?: string;
    }
  ): Promise<Page<Course>> {
    const list: Course[] = [];

    for (const course of this.courses.values()) {
      if (course.deletedAt) continue;

      const isAuthor = actorId !== undefined && course.authorId === actorId;
      if (!course.published && !isAuthor) continue;

      if (options?.authorId !== undefined && course.authorId !== options.authorId) continue;
      if (options?.difficulty !== undefined && course.difficulty !== options.difficulty) continue;

      if (options?.search) {
        const term = options.search.toLowerCase();
        const matches = course.title.toLowerCase().includes(term) || course.description.toLowerCase().includes(term);
        if (!matches) continue;
      }

      list.push(course);
    }

    list.sort(compareCourses);
    return paginate(list, options);
  }

  // --- Lessons -------------------------------------------------------------

  async createLesson(_id: string, courseId: string, actorId: string, title: string, _at = new Date()): Promise<Lesson> {
    const course = await this.getCourse(courseId, actorId);
    if (course.authorId !== actorId) {
      throw new LearningRuleError('not_authorized', 'Only the course author may add lessons');
    }

    if (!title.trim()) {
      throw new LearningRuleError('invalid_input', 'Lesson title cannot be empty');
    }

    if (this.lessons.has(_id)) {
      throw new LearningRuleError('invalid_input', `Lesson with id '${_id}' already exists`);
    }

    const activeLessons = Array.from(this.lessons.values()).filter(
      (l) => l.courseId === courseId && !l.deletedAt
    );

    const lesson: Lesson = {
      id: _id,
      courseId,
      title: title.trim(),
      orderIndex: activeLessons.length,
    };

    this.lessons.set(_id, lesson);
    return lesson;
  }

  private async lessonWithCourse(
    lessonId: string,
    actorId?: string
  ): Promise<{ lesson: Lesson; course: Course }> {
    const lesson = this.lessons.get(lessonId);
    if (!lesson || lesson.deletedAt) {
      throw new LearningRuleError('not_found', `Lesson '${lessonId}' not found`);
    }

    const course = await this.getCourse(lesson.courseId, actorId);
    return { lesson, course };
  }

  async getLesson(lessonId: string, actorId?: string): Promise<Lesson> {
    return (await this.lessonWithCourse(lessonId, actorId)).lesson;
  }

  async listLessons(courseId: string, actorId?: string): Promise<readonly Lesson[]> {
    await this.getCourse(courseId, actorId);

    const list = Array.from(this.lessons.values()).filter(
      (l) => l.courseId === courseId && !l.deletedAt
    );
    list.sort(compareLessons);
    return list;
  }

  async updateLesson(
    lessonId: string,
    actorId: string,
    updates: { title?: string },
    _at = new Date()
  ): Promise<Lesson> {
    const lesson = await this.getLesson(lessonId, actorId);
    const course = await this.getCourse(lesson.courseId, actorId);

    if (course.authorId !== actorId) {
      throw new LearningRuleError('not_authorized', 'Only the course author may update lessons');
    }

    let newTitle = lesson.title;
    if (updates.title !== undefined) {
      if (!updates.title.trim()) {
        throw new LearningRuleError('invalid_input', 'Lesson title cannot be empty');
      }
      newTitle = updates.title.trim();
    }

    const updated: Lesson = {
      ...lesson,
      title: newTitle,
    };

    this.lessons.set(lessonId, updated);
    return updated;
  }

  async reorderLessons(
    courseId: string,
    actorId: string,
    lessonIds: readonly string[],
    _at = new Date()
  ): Promise<readonly Lesson[]> {
    const course = await this.getCourse(courseId, actorId);
    if (course.authorId !== actorId) {
      throw new LearningRuleError('not_authorized', 'Only the course author may reorder lessons');
    }

    const activeLessons = Array.from(this.lessons.values()).filter(
      (l) => l.courseId === courseId && !l.deletedAt
    );

    if (lessonIds.length !== activeLessons.length) {
      throw new LearningRuleError(
        'invalid_input',
        `Reorder lessonIds count (${lessonIds.length}) does not match active lessons count (${activeLessons.length})`
      );
    }

    const activeIdsSet = new Set(activeLessons.map((l) => l.id));
    for (const id of lessonIds) {
      if (!activeIdsSet.has(id)) {
        throw new LearningRuleError('invalid_input', `Lesson '${id}' does not belong to course '${courseId}'`);
      }
    }

    if (new Set(lessonIds).size !== lessonIds.length) {
      throw new LearningRuleError('invalid_input', 'Duplicate lesson IDs in reorder request');
    }

    const updatedLessons: Lesson[] = [];
    for (let index = 0; index < lessonIds.length; index++) {
      const id = lessonIds[index];
      const lesson = this.lessons.get(id)!;
      const updated: Lesson = { ...lesson, orderIndex: index };
      this.lessons.set(id, updated);
      updatedLessons.push(updated);
    }

    updatedLessons.sort(compareLessons);
    return updatedLessons;
  }

  async deleteLesson(lessonId: string, actorId: string, at = new Date()): Promise<Lesson> {
    const lesson = this.lessons.get(lessonId);
    if (!lesson || lesson.deletedAt) {
      throw new LearningRuleError('not_found', `Lesson '${lessonId}' not found`);
    }

    const course = await this.getCourse(lesson.courseId, actorId);
    if (course.authorId !== actorId) {
      throw new LearningRuleError('not_authorized', 'Only the course author may delete lessons');
    }

    const tombstoned: Lesson = {
      ...lesson,
      deletedAt: at,
    };
    this.lessons.set(lessonId, tombstoned);

    // Compact remaining lessons
    const remaining = Array.from(this.lessons.values())
      .filter((l) => l.courseId === lesson.courseId && !l.deletedAt)
      .sort(compareLessons);

    for (let index = 0; index < remaining.length; index++) {
      const item = remaining[index];
      this.lessons.set(item.id, { ...item, orderIndex: index });
    }

    return tombstoned;
  }

  // --- Steps ---------------------------------------------------------------

  async createStep(
    id: string,
    lessonId: string,
    actorId: string,
    input: CreateStepInput,
    positionReader: PositionReader,
    _at = new Date()
  ): Promise<LessonStep> {
    const lesson = await this.getLesson(lessonId, actorId);
    const course = await this.getCourse(lesson.courseId, actorId);

    if (course.authorId !== actorId) {
      throw new LearningRuleError('not_authorized', 'Only the course author may add steps');
    }

    if (this.steps.has(id)) {
      throw new LearningRuleError('invalid_input', `Step with id '${id}' already exists`);
    }

    const activeSteps = Array.from(this.steps.values()).filter(
      (s) => s.lessonId === lessonId && !s.deletedAt
    );
    const orderIndex = activeSteps.length;

    let step: LessonStep;

    if (input.kind === 'text') {
      if (!input.prose.trim()) {
        throw new LearningRuleError('invalid_input', 'Text step prose cannot be empty');
      }
      step = {
        id,
        lessonId,
        orderIndex,
        kind: 'text',
        prose: input.prose.trim(),
      };
    } else if (input.kind === 'move') {
      if (!input.fen.trim()) {
        throw new LearningRuleError('invalid_input', 'Move step FEN cannot be empty');
      }
      if (!input.expectedSan.trim()) {
        throw new LearningRuleError('invalid_input', 'Move step expectedSan cannot be empty');
      }

      // Rule 4: 'move' step's expectedSan must be legal from its FEN at authoring time.
      try {
        resolveSan(positionReader, input.fen.trim(), input.expectedSan.trim());
      } catch (_err) {
        throw new LearningRuleError(
          'invalid_move',
          `'${input.expectedSan}' is not a legal move from FEN '${input.fen}'`
        );
      }

      step = {
        id,
        lessonId,
        orderIndex,
        kind: 'move',
        fen: input.fen.trim(),
        expectedSan: input.expectedSan.trim(),
        ...(input.hint ? { hint: input.hint.trim() } : {}),
      };
    } else if (input.kind === 'quiz') {
      if (!input.question.trim()) {
        throw new LearningRuleError('invalid_input', 'Quiz question cannot be empty');
      }
      if (input.options.length < 2 || input.options.length > 6) {
        throw new LearningRuleError(
          'invalid_input',
          `Quiz must have between 2 and 6 options (received ${input.options.length})`
        );
      }
      for (const opt of input.options) {
        if (typeof opt !== 'string' || !opt.trim()) {
          throw new LearningRuleError('invalid_input', 'Quiz options cannot contain empty strings');
        }
      }
      if (
        typeof input.correctIndex !== 'number' ||
        !Number.isInteger(input.correctIndex) ||
        input.correctIndex < 0 ||
        input.correctIndex >= input.options.length
      ) {
        throw new LearningRuleError(
          'invalid_input',
          `Quiz correctIndex (${input.correctIndex}) out of bounds (0-${input.options.length - 1})`
        );
      }
      step = {
        id,
        lessonId,
        orderIndex,
        kind: 'quiz',
        question: input.question.trim(),
        options: input.options.map((o) => o.trim()),
        correctIndex: input.correctIndex,
      };
    } else {
      throw new LearningRuleError('invalid_input', 'Invalid step kind');
    }

    this.steps.set(id, step);
    return step;
  }

  async getStepWithCourse(
    stepId: string,
    actorId?: string
  ): Promise<{ step: LessonStep; course: Course }> {
    const step = this.steps.get(stepId);
    if (!step || step.deletedAt) {
      throw new LearningRuleError('not_found', `Step '${stepId}' not found`);
    }

    const lesson = this.lessons.get(step.lessonId);
    if (!lesson || lesson.deletedAt) {
      throw new LearningRuleError('not_found', `Step '${stepId}' not found`);
    }

    const course = await this.getCourse(lesson.courseId, actorId);
    return { step, course };
  }

  async getStep(stepId: string, actorId?: string): Promise<LessonStep> {
    return (await this.getStepWithCourse(stepId, actorId)).step;
  }

  async listStepsWithCourse(
    lessonId: string,
    actorId?: string
  ): Promise<{ steps: readonly LessonStep[]; course: Course }> {
    const { course } = await this.lessonWithCourse(lessonId, actorId);

    const list = Array.from(this.steps.values()).filter(
      (s) => s.lessonId === lessonId && !s.deletedAt
    );
    list.sort(compareSteps);
    return { steps: list, course };
  }

  async listSteps(lessonId: string, actorId?: string): Promise<readonly LessonStep[]> {
    return (await this.listStepsWithCourse(lessonId, actorId)).steps;
  }

  async updateStep(
    stepId: string,
    actorId: string,
    updates: UpdateStepInput,
    positionReader: PositionReader,
    _at = new Date()
  ): Promise<LessonStep> {
    const step = await this.getStep(stepId, actorId);
    const lesson = this.lessons.get(step.lessonId)!;
    const course = await this.getCourse(lesson.courseId, actorId);

    if (course.authorId !== actorId) {
      throw new LearningRuleError('not_authorized', 'Only the course author may update steps');
    }

    let updatedStep: LessonStep;

    if (step.kind === 'text') {
      const proseUpdate = (updates as { prose?: string }).prose;
      let newProse = step.prose;
      if (proseUpdate !== undefined) {
        if (!proseUpdate.trim()) {
          throw new LearningRuleError('invalid_input', 'Text step prose cannot be empty');
        }
        newProse = proseUpdate.trim();
      }
      updatedStep = { ...step, prose: newProse };
    } else if (step.kind === 'move') {
      const moveUpdates = updates as { fen?: string; expectedSan?: string; hint?: string };
      const newFen = moveUpdates.fen !== undefined ? moveUpdates.fen.trim() : step.fen;
      const newExpectedSan = moveUpdates.expectedSan !== undefined ? moveUpdates.expectedSan.trim() : step.expectedSan;
      const newHint = moveUpdates.hint !== undefined ? moveUpdates.hint.trim() : step.hint;

      if (!newFen) throw new LearningRuleError('invalid_input', 'Move step FEN cannot be empty');
      if (!newExpectedSan) throw new LearningRuleError('invalid_input', 'Move step expectedSan cannot be empty');

      // Rule 4: Validate move legality at authoring time
      try {
        resolveSan(positionReader, newFen, newExpectedSan);
      } catch (_err) {
        throw new LearningRuleError('invalid_move', `'${newExpectedSan}' is not a legal move from FEN '${newFen}'`);
      }

      updatedStep = {
        ...step,
        fen: newFen,
        expectedSan: newExpectedSan,
        ...(newHint ? { hint: newHint } : {}),
      };
    } else if (step.kind === 'quiz') {
      const quizUpdates = updates as { question?: string; options?: readonly string[]; correctIndex?: number };
      const newQuestion = quizUpdates.question !== undefined ? quizUpdates.question.trim() : step.question;
      const newOptions = quizUpdates.options !== undefined ? quizUpdates.options.map((o) => o.trim()) : step.options;
      const newCorrectIndex = quizUpdates.correctIndex !== undefined ? quizUpdates.correctIndex : step.correctIndex;

      if (!newQuestion) throw new LearningRuleError('invalid_input', 'Quiz question cannot be empty');
      if (newOptions.length < 2 || newOptions.length > 6) {
        throw new LearningRuleError('invalid_input', `Quiz must have between 2 and 6 options (received ${newOptions.length})`);
      }
      for (const opt of newOptions) {
        if (!opt) throw new LearningRuleError('invalid_input', 'Quiz options cannot contain empty strings');
      }
      if (
        typeof newCorrectIndex !== 'number' ||
        !Number.isInteger(newCorrectIndex) ||
        newCorrectIndex < 0 ||
        newCorrectIndex >= newOptions.length
      ) {
        throw new LearningRuleError('invalid_input', `Quiz correctIndex (${newCorrectIndex}) out of bounds`);
      }

      updatedStep = {
        ...step,
        question: newQuestion,
        options: newOptions,
        correctIndex: newCorrectIndex,
      };
    } else {
      throw new LearningRuleError('invalid_input', 'Invalid step kind');
    }

    this.steps.set(stepId, updatedStep);
    return updatedStep;
  }

  async reorderSteps(
    lessonId: string,
    actorId: string,
    stepIds: readonly string[],
    _at = new Date()
  ): Promise<readonly LessonStep[]> {
    const lesson = await this.getLesson(lessonId, actorId);
    const course = await this.getCourse(lesson.courseId, actorId);

    if (course.authorId !== actorId) {
      throw new LearningRuleError('not_authorized', 'Only the course author may reorder steps');
    }

    const activeSteps = Array.from(this.steps.values()).filter(
      (s) => s.lessonId === lessonId && !s.deletedAt
    );

    if (stepIds.length !== activeSteps.length) {
      throw new LearningRuleError(
        'invalid_input',
        `Reorder stepIds count (${stepIds.length}) does not match active steps count (${activeSteps.length})`
      );
    }

    const activeIdsSet = new Set(activeSteps.map((s) => s.id));
    for (const id of stepIds) {
      if (!activeIdsSet.has(id)) {
        throw new LearningRuleError('invalid_input', `Step '${id}' does not belong to lesson '${lessonId}'`);
      }
    }

    if (new Set(stepIds).size !== stepIds.length) {
      throw new LearningRuleError('invalid_input', 'Duplicate step IDs in reorder request');
    }

    const updatedSteps: LessonStep[] = [];
    for (let index = 0; index < stepIds.length; index++) {
      const id = stepIds[index];
      const step = this.steps.get(id)!;
      const updated: LessonStep = { ...step, orderIndex: index };
      this.steps.set(id, updated);
      updatedSteps.push(updated);
    }

    updatedSteps.sort(compareSteps);
    return updatedSteps;
  }

  async deleteStep(stepId: string, actorId: string, at = new Date()): Promise<LessonStep> {
    const step = this.steps.get(stepId);
    if (!step || step.deletedAt) {
      throw new LearningRuleError('not_found', `Step '${stepId}' not found`);
    }

    const lesson = this.lessons.get(step.lessonId);
    if (!lesson || lesson.deletedAt) {
      throw new LearningRuleError('not_found', `Step '${stepId}' not found`);
    }

    const course = await this.getCourse(lesson.courseId, actorId);
    if (course.authorId !== actorId) {
      throw new LearningRuleError('not_authorized', 'Only the course author may delete steps');
    }

    const tombstoned: LessonStep = {
      ...step,
      deletedAt: at,
    };
    this.steps.set(stepId, tombstoned);

    // Compact remaining steps
    const remaining = Array.from(this.steps.values())
      .filter((s) => s.lessonId === step.lessonId && !s.deletedAt)
      .sort(compareSteps);

    for (let index = 0; index < remaining.length; index++) {
      const item = remaining[index];
      this.steps.set(item.id, { ...item, orderIndex: index });
    }

    return tombstoned;
  }

  // --- Progress & Attempts -------------------------------------------------

  async submitAttempt(
    playerId: string,
    stepId: string,
    attempt: StepAttemptInput,
    at = new Date()
  ): Promise<AttemptResult> {
    const step = await this.getStep(stepId, playerId);
    const lesson = this.lessons.get(step.lessonId)!;
    const course = this.courses.get(lesson.courseId)!;

    let isCorrect = false;

    if (step.kind === 'text') {
      isCorrect = true;
    } else if (step.kind === 'move') {
      if (!attempt.san || typeof attempt.san !== 'string' || !attempt.san.trim()) {
        throw new LearningRuleError('invalid_input', 'SAN move required for move step');
      }
      isCorrect = bareSan(attempt.san.trim()) === bareSan((step as MoveLessonStep).expectedSan);
    } else if (step.kind === 'quiz') {
      const quizStep = step as QuizLessonStep;
      if (
        attempt.selectedIndex === undefined ||
        typeof attempt.selectedIndex !== 'number' ||
        !Number.isInteger(attempt.selectedIndex)
      ) {
        throw new LearningRuleError('invalid_input', 'Quiz selectedIndex required');
      }

      // Rule 6: Quiz answer index outside options range is rejected, not scored as wrong.
      if (attempt.selectedIndex < 0 || attempt.selectedIndex >= quizStep.options.length) {
        throw new LearningRuleError(
          'invalid_input',
          `Quiz answer index (${attempt.selectedIndex}) outside options range (0-${quizStep.options.length - 1})`
        );
      }

      isCorrect = attempt.selectedIndex === quizStep.correctIndex;
    }

    const key = `${playerId}:${stepId}`;
    const existing = this.progress.get(key);

    if (existing) {
      if (existing.completedAt !== undefined) {
        // Rule 5: Submitting attempt is idempotent per (player, step): re-submitting a correct answer
        // does not move completedAt and does not inflate attempts beyond what actually happened.
        if (isCorrect) {
          return {
            stepId,
            correct: true,
            completedAt: existing.completedAt,
            attempts: existing.attempts,
          };
        }
        // Submitting an incorrect answer after already completing step
        const updatedProgress: Progress = {
          ...existing,
          attempts: existing.attempts + 1,
        };
        this.progress.set(key, updatedProgress);
        return {
          stepId,
          correct: false,
          completedAt: existing.completedAt,
          attempts: updatedProgress.attempts,
        };
      }

      // Step was not yet completed
      const newAttempts = existing.attempts + 1;
      const completedAt = isCorrect ? at : undefined;
      const updatedProgress: Progress = {
        ...existing,
        attempts: newAttempts,
        ...(completedAt ? { completedAt } : {}),
      };
      this.progress.set(key, updatedProgress);
      return {
        stepId,
        correct: isCorrect,
        ...(completedAt ? { completedAt } : {}),
        attempts: newAttempts,
      };
    }

    // First attempt
    const completedAt = isCorrect ? at : undefined;
    const newProgress: Progress = {
      playerId,
      courseId: course.id,
      lessonId: lesson.id,
      stepId,
      attempts: 1,
      ...(completedAt ? { completedAt } : {}),
    };
    this.progress.set(key, newProgress);

    return {
      stepId,
      correct: isCorrect,
      ...(completedAt ? { completedAt } : {}),
      attempts: 1,
    };
  }

  async getProgressSummary(playerId: string, courseId: string): Promise<CourseProgressSummary> {
    const course = await this.getCourse(courseId, playerId);

    const activeLessons = Array.from(this.lessons.values()).filter(
      (l) => l.courseId === course.id && !l.deletedAt
    );
    const activeLessonIds = new Set(activeLessons.map((l) => l.id));

    const activeSteps = Array.from(this.steps.values()).filter(
      (s) => activeLessonIds.has(s.lessonId) && !s.deletedAt
    );
    const activeStepIds = new Set(activeSteps.map((s) => s.id));

    let completedSteps = 0;
    for (const p of this.progress.values()) {
      if (p.playerId === playerId && activeStepIds.has(p.stepId) && p.completedAt !== undefined) {
        completedSteps++;
      }
    }

    return {
      courseId: course.id,
      playerId,
      totalSteps: activeSteps.length,
      completedSteps,
    };
  }

  async listProgress(playerId: string, courseId: string): Promise<readonly Progress[]> {
    await this.getCourse(courseId, playerId);

    const list = Array.from(this.progress.values()).filter(
      (p) => p.playerId === playerId && p.courseId === courseId
    );
    list.sort(compareProgress);
    return list;
  }
}
