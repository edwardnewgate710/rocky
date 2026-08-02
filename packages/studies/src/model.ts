import { StudyRuleError } from './errors';

/** Visibility options for a study. */
export type StudyVisibility = 'public' | 'unlisted' | 'private';

/** Roles a collaborator can hold in a study. */
export type StudyRole = 'owner' | 'contributor' | 'viewer';

/**
 * Numeric authority rank: owner (3) > contributor (2) > viewer (1).
 */
export function roleRank(role: StudyRole): number {
  switch (role) {
    case 'owner':
      return 3;
    case 'contributor':
      return 2;
    case 'viewer':
      return 1;
  }
}

/**
 * A Study: a collection of chapters created by an owner and optionally collaborated on.
 */
export interface Study {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly description: string;
  readonly visibility: StudyVisibility;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt?: Date;
}

/**
 * A Chapter within a Study.
 */
export interface Chapter {
  readonly id: string;
  readonly studyId: string;
  readonly name: string;
  readonly orderIndex: number;
  readonly startingFen: string;
  readonly deletedAt?: Date;
}

/**
 * A Node in a Chapter's analysis tree.
 */
export interface TreeNode {
  readonly id: string;
  readonly chapterId: string;
  readonly parentId: string | null;
  readonly san: string;
  readonly fenAfter: string;
  readonly comment?: string;
  readonly nags: readonly number[];
  readonly orderIndex: number;
}

/**
 * A Collaborator on a Study.
 */
export interface Collaborator {
  readonly studyId: string;
  readonly playerId: string;
  readonly role: StudyRole;
}

/** Standard starting FEN. */
export const DEFAULT_STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Longest name a study or chapter may carry, after trimming. */
export const MAX_NAME_LENGTH = 255;

/**
 * Trims a study or chapter name and rejects what cannot be stored, returning the value to store.
 *
 * One function rather than one per entity: the rule is identical, and written out twice it is two
 * places to change and one to forget. Increment 5 shipped exactly that — the same validation
 * duplicated across two adapters, already disagreeing about fractions by the time anyone looked.
 *
 * It returns rather than merely asserting, which is why it is not called `assert*`: callers need
 * the trimmed value, and a name that promises a check while quietly also transforming is the kind
 * of thing a reader only discovers by being bitten.
 */
export function normalizeName(name: string, label: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new StudyRuleError('invalid_input', `${label} name cannot be empty`);
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new StudyRuleError(
      'invalid_input',
      `${label} name cannot exceed ${MAX_NAME_LENGTH} characters`
    );
  }
  return trimmed;
}

export function normalizeStudyName(name: string): string {
  return normalizeName(name, 'Study');
}

export function normalizeChapterName(name: string): string {
  return normalizeName(name, 'Chapter');
}
