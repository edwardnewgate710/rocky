import type { Course, Lesson, LessonStep, Progress } from './model';

/**
 * Compares two strings by UTF-16 code-unit order — what `<` does, and deliberately not
 * `localeCompare`, whose answer depends on the machine's locale and so cannot be reproduced by a
 * database ORDER BY.
 *
 * Code UNITS, not code points: the two differ above the BMP, where a surrogate pair sorts before
 * some single-unit characters. Every id compared here is an ASCII UUID, where the orders coincide
 * and also coincide with the byte order Postgres uses.
 */
export function compareStringsCodePoint(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Order courses by `createdAt` DESC, tie-broken by `id` ASC in code-point order.
 */
export function compareCourses(a: Course, b: Course): number {
  const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
  if (timeDiff !== 0) return timeDiff;
  return compareStringsCodePoint(a.id, b.id);
}

/**
 * Order lessons by `orderIndex` ASC, tie-broken by `id` ASC in code-point order.
 */
export function compareLessons(a: Lesson, b: Lesson): number {
  const orderDiff = a.orderIndex - b.orderIndex;
  if (orderDiff !== 0) return orderDiff;
  return compareStringsCodePoint(a.id, b.id);
}

/**
 * Order steps by `orderIndex` ASC, tie-broken by `id` ASC in code-point order.
 */
export function compareSteps(a: LessonStep, b: LessonStep): number {
  const orderDiff = a.orderIndex - b.orderIndex;
  if (orderDiff !== 0) return orderDiff;
  return compareStringsCodePoint(a.id, b.id);
}

/**
 * Order progress rows by `stepId` ASC in code-point order.
 */
export function compareProgress(a: Progress, b: Progress): number {
  return compareStringsCodePoint(a.stepId, b.stepId);
}
