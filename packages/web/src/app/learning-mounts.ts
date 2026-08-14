import type { GambitClient } from '../api/client.js';
import type { SubmitAttemptRequest } from '../api/models.js';
import { LearningController } from './learning-controller.js';
import type { LearningCallbacks } from './learning-controller.js';
import { courseProgressLabel, stepStatusLabel } from './learning-helpers.js';
import { renderCourseDetail, renderCourseList, renderLessonDetail } from './learning-view.js';

interface LearningMountDependencies {
  readonly doc: Document;
  readonly client: GambitClient;
  readonly surface: HTMLElement;
}

interface SessionBoundLearningMountDependencies extends LearningMountDependencies {
  readonly sessionPresent: boolean;
  readonly restorePromise: Promise<unknown>;
}

interface CourseMountDependencies extends SessionBoundLearningMountDependencies {
  readonly slug: string;
}

interface LessonMountDependencies extends SessionBoundLearningMountDependencies {
  readonly lessonId: string;
}

function loadAfterSessionRestore(
  sessionPresent: boolean,
  restorePromise: Promise<unknown>,
  load: () => void,
): void {
  if (sessionPresent) load();
  else void restorePromise.then(() => load()).catch(() => undefined);
}

function renderUnavailable(doc: Document, surface: HTMLElement): void {
  surface.replaceChildren();
  const message = doc.createElement('p');
  message.className = 'count';
  message.textContent = 'Learning service unavailable.';
  surface.appendChild(message);
}

export function mountCourseList({
  doc,
  client,
  surface,
}: LearningMountDependencies): LearningController {
  const list = doc.getElementById('course-list');
  const error = doc.getElementById('courses-error');
  const controller = new LearningController({
    client,
    callbacks: {
      onCourseList: (courses) => {
        if (error) error.textContent = '';
        if (list) renderCourseList(list, courses);
      },
      onCourse: () => {},
      onLesson: () => {},
      onAttemptResult: () => {},
      onLoading: (loading) => {
        if (list) list.setAttribute('aria-busy', loading ? 'true' : 'false');
      },
      onError: (message) => {
        if (error) error.textContent = message;
      },
      onUnavailable: () => renderUnavailable(doc, surface),
    },
  });

  void controller.loadCourses();
  return controller;
}

function createCourseCallbacks(
  doc: Document,
  surface: HTMLElement,
  error: HTMLElement | null,
): LearningCallbacks {
  return {
    onCourseList: () => {},
    onCourse: (course, lessons, progress) => {
      if (error) error.textContent = '';
      renderCourseDetail(surface, course, lessons, progress);
    },
    onLesson: () => {},
    onAttemptResult: () => {},
    onLoading: (loading) => {
      const list = doc.getElementById('lesson-list');
      if (list) list.setAttribute('aria-busy', loading ? 'true' : 'false');
    },
    onError: (message) => {
      if (error) error.textContent = message;
    },
    onUnavailable: () => renderUnavailable(doc, surface),
  };
}

export function mountCourseDetail({
  doc,
  client,
  surface,
  slug,
  sessionPresent,
  restorePromise,
}: CourseMountDependencies): LearningController {
  const controller = new LearningController({
    client,
    callbacks: createCourseCallbacks(doc, surface, doc.getElementById('course-error')),
  });

  loadAfterSessionRestore(sessionPresent, restorePromise, () => void controller.loadCourse(slug));
  return controller;
}

function createLessonCallbacks(
  doc: Document,
  surface: HTMLElement,
  error: HTMLElement | null,
  submitAttempt: (
    stepId: string,
    courseId: string,
    input: SubmitAttemptRequest,
  ) => Promise<void>,
): LearningCallbacks {
  let currentCourseId = '';
  return {
    onCourseList: () => {},
    onCourse: () => {},
    onLesson: (lesson, steps, progress, stepAttempts) => {
      currentCourseId = lesson.courseId;
      if (error) error.textContent = '';
      renderLessonDetail(
        surface,
        lesson,
        steps,
        progress,
        stepAttempts,
        (stepId, input) => submitAttempt(stepId, currentCourseId, input),
      );
    },
    onAttemptResult: (stepId, result, courseProgress) => {
      const stepCard = surface.querySelector(`[data-step-id="${stepId}"]`);
      if (stepCard) {
        const status = stepCard.querySelector('.step-status');
        if (status) status.textContent = stepStatusLabel(result);
      }
      const progress = doc.getElementById('lesson-progress');
      if (progress) progress.textContent = courseProgressLabel(courseProgress);
    },
    onLoading: (loading) => {
      const stepList = doc.getElementById('step-list');
      if (stepList) stepList.setAttribute('aria-busy', loading ? 'true' : 'false');
    },
    onError: (message) => {
      if (error) error.textContent = message;
    },
    onUnavailable: () => renderUnavailable(doc, surface),
  };
}

export function mountLesson({
  doc,
  client,
  surface,
  lessonId,
  sessionPresent,
  restorePromise,
}: LessonMountDependencies): LearningController {
  let controller: LearningController;
  controller = new LearningController({
    client,
    callbacks: createLessonCallbacks(doc, surface, doc.getElementById('lesson-error'), async (
      stepId,
      courseId,
      input,
    ) => {
      await controller.submitAttempt(stepId, courseId, input);
    }),
  });

  loadAfterSessionRestore(sessionPresent, restorePromise, () => void controller.loadLesson(lessonId));
  return controller;
}
