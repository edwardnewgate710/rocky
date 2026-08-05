import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LearningController } from '../src/app/learning-controller.js';
import { httpErrorFrom } from '../src/net/errors.js';
import type { AttemptResultView, CourseView, LessonView } from '../src/api/models.js';

const COURSE: CourseView = {
  id: 'c1',
  authorId: 'a1',
  slug: 'beginner-tactics',
  title: 'Beginner Tactics',
  description: 'Learn basic tactics.',
  difficulty: 'beginner',
  published: true,
  createdAt: '2026-08-05T00:00:00Z',
  updatedAt: '2026-08-05T00:00:00Z',
};

const LESSON: LessonView = {
  id: 'l1',
  courseId: 'c1',
  title: 'Lesson 1',
  orderIndex: 0,
};

interface Captured {
  readonly loaded: number;
  readonly unavailable: number;
  readonly errors: string[];
  readonly requests: number;
}

function makeController(failWith: unknown = null, authenticated = false) {
  let requests = 0;
  let loaded = 0;
  let unavailable = 0;
  const errors: string[] = [];
  const attemptResults: AttemptResultView[] = [];

  const client = {
    session: { isAuthenticated: authenticated },
    learning: {
      listCourses: async () => {
        requests += 1;
        if (failWith !== null) throw failWith;
        return { total: 1, items: [COURSE] };
      },
      courseBySlug: async () => {
        requests += 1;
        if (failWith !== null) throw failWith;
        return COURSE;
      },
      lessons: async () => {
        requests += 1;
        if (failWith !== null) throw failWith;
        return [LESSON];
      },
      progress: async () => {
        requests += 1;
        if (failWith !== null) throw failWith;
        return { courseId: 'c1', playerId: 'p1', totalSteps: 3, completedSteps: 1 };
      },
      progressDetails: async () => {
        requests += 1;
        if (failWith !== null) throw failWith;
        return [
          { playerId: 'p1', courseId: 'c1', lessonId: 'l1', stepId: 's1', completedAt: '2026-08-05T00:00:00Z', attempts: 1 },
        ];
      },
      lesson: async () => {
        requests += 1;
        if (failWith !== null) throw failWith;
        return LESSON;
      },
      steps: async () => {
        requests += 1;
        if (failWith !== null) throw failWith;
        return [
          { id: 's1', lessonId: 'l1', orderIndex: 0, kind: 'text', prose: 'Intro' },
        ];
      },
      attempt: async () => {
        requests += 1;
        if (failWith !== null) throw failWith;
        return { stepId: 's1', correct: true, attempts: 1 };
      },
    },
  };

  let lastLessonAttempts: ReadonlyMap<string, AttemptResultView> | null = null;

  const controller = new LearningController({
    client: client as never,
    callbacks: {
      onCourseList: () => { loaded += 1; },
      onCourse: () => { loaded += 1; },
      onLesson: (_lesson, _steps, _progress, stepAttempts) => {
        loaded += 1;
        lastLessonAttempts = stepAttempts;
      },
      onAttemptResult: (_stepId, result) => {
        attemptResults.push(result);
      },
      onLoading: () => {},
      onError: (message) => { errors.push(message); },
      onUnavailable: () => { unavailable += 1; },
    },
  });

  const captured = {
    get loaded() { return loaded; },
    get unavailable() { return unavailable; },
    get errors() { return errors; },
    get requests() { return requests; },
    get lastLessonAttempts() { return lastLessonAttempts; },
    attemptResults,
  };

  return { controller, captured };
}

test('a deployment without learning service is asked once, then latches on 503', async () => {
  const { controller, captured } = makeController(httpErrorFrom(503, undefined));

  await controller.loadCourses();
  assert.equal(captured.unavailable, 1);
  assert.equal(captured.errors.length, 0);
  assert.equal(captured.loaded, 0);

  const afterFirstCall = captured.requests;

  // Next calls should immediately latch without making network requests
  await controller.loadCourses();
  await controller.loadCourse('beginner-tactics');
  assert.equal(captured.requests, afterFirstCall);
  assert.equal(captured.unavailable, 3);
});

test('a server fault (500) is reported and does not stop subsequent requests', async () => {
  const { controller, captured } = makeController(httpErrorFrom(500, undefined));

  await controller.loadCourses();
  assert.equal(captured.errors.length, 1);
  assert.equal(captured.unavailable, 0);

  // Subsequent call still executes requests (does not latch on 500)
  await controller.loadCourses();
  assert.equal(captured.errors.length, 2);
  assert.equal(captured.requests, 2);
});

test('a foreign error carrying status 503 is reported rather than latching', async () => {
  const foreign = Object.assign(new Error('socket closed'), { status: 503 });
  const { controller, captured } = makeController(foreign);

  await controller.loadCourses();
  assert.equal(captured.unavailable, 0);
  assert.deepEqual(captured.errors, ['socket closed']);
});

test('loadLesson when authenticated populates step attempt state from progressDetails', async () => {
  const { controller, captured } = makeController(null, true);

  await controller.loadLesson('l1');
  assert.equal(captured.loaded, 1);
  assert.notEqual(captured.lastLessonAttempts, null);
  assert.equal(captured.lastLessonAttempts?.get('s1')?.correct, true);
});

test('submitAttempt discards stale response if generation changes', async () => {
  const { controller, captured } = makeController();

  const promise = controller.submitAttempt('s1', 'c1', {});
  controller.reset();
  const res = await promise;

  assert.equal(res, null);
  assert.equal(captured.attemptResults.length, 0);
});
