import { LearningRuleError } from './errors';

export type CourseDifficulty = 'beginner' | 'intermediate' | 'advanced';

export interface Course {
  readonly id: string;
  readonly authorId: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly difficulty: CourseDifficulty;
  readonly published: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt?: Date;
}

export interface Lesson {
  readonly id: string;
  readonly courseId: string;
  readonly title: string;
  readonly orderIndex: number;
  readonly deletedAt?: Date;
}

export type StepKind = 'text' | 'move' | 'quiz';

export interface LessonStepBase {
  readonly id: string;
  readonly lessonId: string;
  readonly orderIndex: number;
  readonly kind: StepKind;
  readonly deletedAt?: Date;
}

export interface TextLessonStep extends LessonStepBase {
  readonly kind: 'text';
  readonly prose: string;
}

export interface MoveLessonStep extends LessonStepBase {
  readonly kind: 'move';
  readonly fen: string;
  readonly expectedSan: string;
  readonly hint?: string;
}

export interface QuizLessonStep extends LessonStepBase {
  readonly kind: 'quiz';
  readonly question: string;
  readonly options: readonly string[];
  readonly correctIndex: number;
}

export type LessonStep = TextLessonStep | MoveLessonStep | QuizLessonStep;

export interface Progress {
  readonly playerId: string;
  readonly courseId: string;
  readonly lessonId: string;
  readonly stepId: string;
  readonly completedAt?: Date;
  readonly attempts: number;
}

export interface CourseProgressSummary {
  readonly courseId: string;
  readonly playerId: string;
  readonly totalSteps: number;
  readonly completedSteps: number;
}

export interface StepAttemptInput {
  readonly san?: string;
  readonly selectedIndex?: number;
}

export interface AttemptResult {
  readonly stepId: string;
  readonly correct: boolean;
  readonly completedAt?: Date;
  readonly attempts: number;
}

export type CreateStepInput =
  | { readonly kind: 'text'; readonly prose: string }
  | { readonly kind: 'move'; readonly fen: string; readonly expectedSan: string; readonly hint?: string }
  | { readonly kind: 'quiz'; readonly question: string; readonly options: readonly string[]; readonly correctIndex: number };

export type UpdateStepInput =
  | { readonly prose?: string }
  | { readonly fen?: string; readonly expectedSan?: string; readonly hint?: string }
  | { readonly question?: string; readonly options?: readonly string[]; readonly correctIndex?: number };

/**
 * Validates and normalizes course slugs.
 *
 * Slugs are constrained to lowercase alphanumeric characters separated by single hyphens (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`).
 * Any input that is empty, contains leading/trailing whitespace, uppercase characters, or invalid symbols is rejected
 * with an `invalid_input` error rather than silently rewritten, ensuring strict API input discipline.
 */
export function validateAndNormalizeSlug(raw: string): string {
  if (typeof raw !== 'string') {
    throw new LearningRuleError('invalid_input', 'Slug must be a string');
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new LearningRuleError('invalid_input', 'Slug cannot be empty');
  }
  if (trimmed !== raw) {
    throw new LearningRuleError('invalid_input', 'Slug cannot contain leading or trailing whitespace');
  }
  const lower = trimmed.toLowerCase();
  if (lower !== raw) {
    throw new LearningRuleError('invalid_input', 'Slug must be strictly lowercase');
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw)) {
    throw new LearningRuleError(
      'invalid_input',
      `Slug '${raw}' contains invalid characters (must contain only lowercase alphanumeric characters and single hyphens)`
    );
  }
  return raw;
}
