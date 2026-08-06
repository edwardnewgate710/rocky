import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from './helpers.js';
import { InMemoryLearningRepository, type LearningRepository } from '@chess-platform/learning';

describe('Learning & Courses REST API', () => {
  let harness: Harness;
  let author: { userId: string; token: string };
  let student: { userId: string; token: string };
  let outsider: { userId: string; token: string };

  before(async () => {
    harness = await startHarness();
    author = await harness.makeUser('CourseAuthor');
    student = await harness.makeUser('StudentUser');
    outsider = await harness.makeUser('OutsiderUser');
  });

  after(async () => {
    if (harness) {
      await harness.close();
    }
  });

  describe('Course CRUD & Visibility', () => {
    let courseId: string;
    let draftCourseId: string;

    it('creates a published course', async () => {
      const res = await harness.json('POST', '/v1/courses', {
        token: author.token,
        body: {
          slug: 'chess-basics-101',
          title: 'Chess Basics 101',
          description: 'Fundamental rules and piece movement',
          difficulty: 'beginner',
          published: true,
        },
      });
      assert.equal(res.status, 201);
      assert.ok(res.body.id);
      assert.equal(res.body.slug, 'chess-basics-101');
      assert.equal(res.body.authorId, author.userId);
      assert.equal(res.body.published, true);
      courseId = res.body.id;
    });

    it('returns 409 when creating course with duplicate slug', async () => {
      const res = await harness.json('POST', '/v1/courses', {
        token: author.token,
        body: {
          slug: 'chess-basics-101',
          title: 'Duplicate',
          difficulty: 'beginner',
        },
      });
      assert.equal(res.status, 409);
    });

    it('creates a draft course and verifies visibility rules', async () => {
      const createRes = await harness.json('POST', '/v1/courses', {
        token: author.token,
        body: {
          slug: 'advanced-endgames',
          title: 'Advanced Endgames',
          difficulty: 'advanced',
          published: false,
        },
      });
      assert.equal(createRes.status, 201);
      draftCourseId = createRes.body.id;

      // Author can view draft
      const authorGet = await harness.json('GET', `/v1/courses/${draftCourseId}`, { token: author.token });
      assert.equal(authorGet.status, 200);

      // Non-author gets 404
      const studentGet = await harness.json('GET', `/v1/courses/${draftCourseId}`, { token: student.token });
      assert.equal(studentGet.status, 404);
    });

    it('fetches course by slug', async () => {
      const res = await harness.json('GET', '/v1/courses/slug/chess-basics-101');
      assert.equal(res.status, 200);
      assert.equal(res.body.id, courseId);
    });

    it('lists courses with pagination and search filtering', async () => {
      const listRes = await harness.json('GET', '/v1/courses?limit=10&offset=0&search=basics');
      assert.equal(listRes.status, 200);
      assert.ok(listRes.body.items);
      assert.equal(listRes.body.items.length, 1);
      assert.equal(listRes.body.items[0].id, courseId);
    });

    it('updates course details', async () => {
      const patchRes = await harness.json('PATCH', `/v1/courses/${courseId}`, {
        token: author.token,
        body: { title: 'Updated Chess Basics' },
      });
      assert.equal(patchRes.status, 200);
      assert.equal(patchRes.body.title, 'Updated Chess Basics');
    });

    it('returns 403 when non-author tries to update or delete course', async () => {
      const patchRes = await harness.json('PATCH', `/v1/courses/${courseId}`, {
        token: student.token,
        body: { title: 'Hacked Title' },
      });
      assert.equal(patchRes.status, 403);

      const delRes = await harness.json('DELETE', `/v1/courses/${courseId}`, {
        token: student.token,
      });
      assert.equal(delRes.status, 403);
    });

    it('publishes and unpublishes a course via endpoint', async () => {
      const unpub = await harness.json('POST', `/v1/courses/${courseId}/unpublish`, { token: author.token });
      assert.equal(unpub.status, 200);
      assert.equal(unpub.body.published, false);

      const pub = await harness.json('POST', `/v1/courses/${courseId}/publish`, { token: author.token });
      assert.equal(pub.status, 200);
      assert.equal(pub.body.published, true);
    });
  });

  describe('Lessons & Steps Management', () => {
    let courseId: string;
    let lesson1Id: string;
    let lesson2Id: string;
    let stepTextId: string;
    let stepMoveId: string;
    let stepQuizId: string;

    before(async () => {
      const cRes = await harness.json('POST', '/v1/courses', {
        token: author.token,
        body: {
          slug: 'mastering-openings',
          title: 'Mastering Openings',
          difficulty: 'intermediate',
          published: true,
        },
      });
      courseId = cRes.body.id;
    });

    it('creates lessons and reorders them', async () => {
      const l1Res = await harness.json('POST', `/v1/courses/${courseId}/lessons`, {
        token: author.token,
        body: { title: 'Italian Game' },
      });
      assert.equal(l1Res.status, 201);
      lesson1Id = l1Res.body.id;
      assert.equal(l1Res.body.orderIndex, 0);

      const l2Res = await harness.json('POST', `/v1/courses/${courseId}/lessons`, {
        token: author.token,
        body: { title: 'Ruy Lopez' },
      });
      assert.equal(l2Res.status, 201);
      lesson2Id = l2Res.body.id;
      assert.equal(l2Res.body.orderIndex, 1);

      // Reorder lessons
      const reorderRes = await harness.json('POST', `/v1/courses/${courseId}/lessons/reorder`, {
        token: author.token,
        body: { lessonIds: [lesson2Id, lesson1Id] },
      });
      assert.equal(reorderRes.status, 200);
      assert.equal(reorderRes.body[0].id, lesson2Id);
      assert.equal(reorderRes.body[0].orderIndex, 0);
      assert.equal(reorderRes.body[1].id, lesson1Id);
      assert.equal(reorderRes.body[1].orderIndex, 1);
    });

    it('creates text, move, and quiz steps in a lesson', async () => {
      // 1. Text step
      const textRes = await harness.json('POST', `/v1/lessons/${lesson1Id}/steps`, {
        token: author.token,
        body: {
          kind: 'text',
          prose: 'The Italian Game starts with 1.e4 e5 2.Nf3 Nc6 3.Bc4',
        },
      });
      assert.equal(textRes.status, 201);
      assert.equal(textRes.body.kind, 'text');
      stepTextId = textRes.body.id;

      // 2. Move step with legal move check
      const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      const moveRes = await harness.json('POST', `/v1/lessons/${lesson1Id}/steps`, {
        token: author.token,
        body: {
          kind: 'move',
          fen: startFen,
          expectedSan: 'e4',
          hint: 'Control center',
        },
      });
      assert.equal(moveRes.status, 201);
      assert.equal(moveRes.body.kind, 'move');
      stepMoveId = moveRes.body.id;

      // Move step with illegal move returns 422
      const badMoveRes = await harness.json('POST', `/v1/lessons/${lesson1Id}/steps`, {
        token: author.token,
        body: {
          kind: 'move',
          fen: startFen,
          expectedSan: 'Ke2',
        },
      });
      assert.equal(badMoveRes.status, 422);

      // 3. Quiz step
      const quizRes = await harness.json('POST', `/v1/lessons/${lesson1Id}/steps`, {
        token: author.token,
        body: {
          kind: 'quiz',
          question: 'What is the key bishop square in the Italian Game?',
          options: ['b5', 'c4', 'd3', 'e2'],
          correctIndex: 1,
        },
      });
      assert.equal(quizRes.status, 201);
      assert.equal(quizRes.body.kind, 'quiz');
      stepQuizId = quizRes.body.id;
    });

    it('lists steps in a lesson', async () => {
      const stepsRes = await harness.json('GET', `/v1/lessons/${lesson1Id}/steps`);
      assert.equal(stepsRes.status, 200);
      assert.equal(stepsRes.body.length, 3);
    });

    it('reorders steps in a lesson', async () => {
      const reorderRes = await harness.json('POST', `/v1/lessons/${lesson1Id}/steps/reorder`, {
        token: author.token,
        body: { stepIds: [stepQuizId, stepMoveId, stepTextId] },
      });
      assert.equal(reorderRes.status, 200);
      assert.equal(reorderRes.body[0].id, stepQuizId);
      assert.equal(reorderRes.body[0].orderIndex, 0);
    });

    describe('Learner-scoped Step View (Public Read Routes)', () => {
      const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

      it('GET /v1/lessons/:id/steps - omits expectedSan/correctIndex for anonymous and non-author, preserves for author', async () => {
        // 1. Anonymous caller
        const anonRes = await harness.json('GET', `/v1/lessons/${lesson1Id}/steps`);
        assert.equal(anonRes.status, 200);
        const moveStepAnon = anonRes.body.find((s: any) => s.id === stepMoveId);
        const quizStepAnon = anonRes.body.find((s: any) => s.id === stepQuizId);
        assert.ok(moveStepAnon);
        assert.ok(quizStepAnon);

        assert.equal('expectedSan' in moveStepAnon, false);
        assert.equal('correctIndex' in quizStepAnon, false);
        assert.equal(moveStepAnon.fen, startFen);
        assert.equal(moveStepAnon.hint, 'Control center');
        assert.equal(quizStepAnon.question, 'What is the key bishop square in the Italian Game?');
        assert.deepEqual(quizStepAnon.options, ['b5', 'c4', 'd3', 'e2']);

        // 2. Non-author authenticated caller
        const studentRes = await harness.json('GET', `/v1/lessons/${lesson1Id}/steps`, {
          token: student.token,
        });
        assert.equal(studentRes.status, 200);
        const moveStepStudent = studentRes.body.find((s: any) => s.id === stepMoveId);
        const quizStepStudent = studentRes.body.find((s: any) => s.id === stepQuizId);
        assert.equal('expectedSan' in moveStepStudent, false);
        assert.equal('correctIndex' in quizStepStudent, false);

        // 3. Course author caller
        const authorRes = await harness.json('GET', `/v1/lessons/${lesson1Id}/steps`, {
          token: author.token,
        });
        assert.equal(authorRes.status, 200);
        const moveStepAuthor = authorRes.body.find((s: any) => s.id === stepMoveId);
        const quizStepAuthor = authorRes.body.find((s: any) => s.id === stepQuizId);
        assert.equal('expectedSan' in moveStepAuthor, true);
        assert.equal(moveStepAuthor.expectedSan, 'e4');
        assert.equal('correctIndex' in quizStepAuthor, true);
        assert.equal(quizStepAuthor.correctIndex, 1);
      });

      it('GET /v1/steps/:id - omits expectedSan/correctIndex for anonymous and non-author, preserves for author', async () => {
        // 1. Anonymous caller on move step
        const moveAnon = await harness.json('GET', `/v1/steps/${stepMoveId}`);
        assert.equal(moveAnon.status, 200);
        assert.equal('expectedSan' in moveAnon.body, false);
        assert.equal(moveAnon.body.fen, startFen);
        assert.equal(moveAnon.body.hint, 'Control center');

        // Anonymous caller on quiz step
        const quizAnon = await harness.json('GET', `/v1/steps/${stepQuizId}`);
        assert.equal(quizAnon.status, 200);
        assert.equal('correctIndex' in quizAnon.body, false);
        assert.equal(quizAnon.body.question, 'What is the key bishop square in the Italian Game?');
        assert.deepEqual(quizAnon.body.options, ['b5', 'c4', 'd3', 'e2']);

        // 2. Non-author authenticated caller
        const moveStudent = await harness.json('GET', `/v1/steps/${stepMoveId}`, { token: student.token });
        assert.equal(moveStudent.status, 200);
        assert.equal('expectedSan' in moveStudent.body, false);

        const quizStudent = await harness.json('GET', `/v1/steps/${stepQuizId}`, { token: student.token });
        assert.equal(quizStudent.status, 200);
        assert.equal('correctIndex' in quizStudent.body, false);

        // 3. Course author caller
        const moveAuthor = await harness.json('GET', `/v1/steps/${stepMoveId}`, { token: author.token });
        assert.equal(moveAuthor.status, 200);
        assert.equal('expectedSan' in moveAuthor.body, true);
        assert.equal(moveAuthor.body.expectedSan, 'e4');

        const quizAuthor = await harness.json('GET', `/v1/steps/${stepQuizId}`, { token: author.token });
        assert.equal(quizAuthor.status, 200);
        assert.equal('correctIndex' in quizAuthor.body, true);
        assert.equal(quizAuthor.body.correctIndex, 1);
      });
    });
  });

  describe('Progress & Attempt Submission', () => {
    let courseId: string;
    let lessonId: string;
    let textStepId: string;
    let moveStepId: string;
    let quizStepId: string;

    before(async () => {
      const cRes = await harness.json('POST', '/v1/courses', {
        token: author.token,
        body: {
          slug: 'tactic-training',
          title: 'Tactic Training',
          difficulty: 'beginner',
          published: true,
        },
      });
      courseId = cRes.body.id;

      const lRes = await harness.json('POST', `/v1/courses/${courseId}/lessons`, {
        token: author.token,
        body: { title: 'Forks & Pins' },
      });
      lessonId = lRes.body.id;

      const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

      const s1 = await harness.json('POST', `/v1/lessons/${lessonId}/steps`, {
        token: author.token,
        body: { kind: 'text', prose: 'Read this intro' },
      });
      textStepId = s1.body.id;

      const s2 = await harness.json('POST', `/v1/lessons/${lessonId}/steps`, {
        token: author.token,
        body: { kind: 'move', fen: startFen, expectedSan: 'e4' },
      });
      moveStepId = s2.body.id;

      const s3 = await harness.json('POST', `/v1/lessons/${lessonId}/steps`, {
        token: author.token,
        body: { kind: 'quiz', question: 'Choose e4', options: ['d4', 'e4'], correctIndex: 1 },
      });
      quizStepId = s3.body.id;
    });

    it('evaluates attempts on text, move, and quiz steps', async () => {
      // 1. Text step attempt auto-completes
      const textAttempt = await harness.json('POST', `/v1/steps/${textStepId}/attempt`, {
        token: student.token,
        body: {},
      });
      assert.equal(textAttempt.status, 200);
      assert.equal(textAttempt.body.correct, true);
      assert.ok(textAttempt.body.completedAt);

      // 2. Move step wrong attempt
      const wrongMove = await harness.json('POST', `/v1/steps/${moveStepId}/attempt`, {
        token: student.token,
        body: { san: 'd4' },
      });
      assert.equal(wrongMove.status, 200);
      assert.equal(wrongMove.body.correct, false);
      assert.equal(wrongMove.body.attempts, 1);
      assert.equal(wrongMove.body.completedAt, undefined);

      // 3. Move step correct attempt
      const rightMove = await harness.json('POST', `/v1/steps/${moveStepId}/attempt`, {
        token: student.token,
        body: { san: 'e4' },
      });
      assert.equal(rightMove.status, 200);
      assert.equal(rightMove.body.correct, true);
      assert.equal(rightMove.body.attempts, 2);
      assert.ok(rightMove.body.completedAt);

      // 4. Quiz step out of bounds index throws 422
      const oobQuiz = await harness.json('POST', `/v1/steps/${quizStepId}/attempt`, {
        token: student.token,
        body: { selectedIndex: 99 },
      });
      assert.equal(oobQuiz.status, 422);

      // 5. Quiz step correct answer
      const rightQuiz = await harness.json('POST', `/v1/steps/${quizStepId}/attempt`, {
        token: student.token,
        body: { selectedIndex: 1 },
      });
      assert.equal(rightQuiz.status, 200);
      assert.equal(rightQuiz.body.correct, true);
    });

    it('fetches player progress summary and progress details', async () => {
      const summaryRes = await harness.json('GET', `/v1/courses/${courseId}/progress`, {
        token: student.token,
      });
      assert.equal(summaryRes.status, 200);
      assert.equal(summaryRes.body.totalSteps, 3);
      assert.equal(summaryRes.body.completedSteps, 3);

      const detailsRes = await harness.json('GET', `/v1/courses/${courseId}/progress/details`, {
        token: student.token,
      });
      assert.equal(detailsRes.status, 200);
      assert.equal(detailsRes.body.length, 3);
    });
  });

  describe('Service Unavailable Fallback (503)', () => {
    it('returns 503 when learning repository is disabled', async () => {
      const unavailHarness = await startHarness({}, { withoutLearning: true });
      try {
        const res = await unavailHarness.json('GET', '/v1/courses');
        assert.equal(res.status, 503);
      } finally {
        await unavailHarness.close();
      }
    });
  });
});

/**
 * Counts the calls a route makes on the repository, without counting the repository's own internal
 * calls: each method is invoked with the raw target as `this`, so `listStepsWithCourse` reaching for
 * `this.getCourse` internally stays inside and never re-enters the proxy. What the map holds is
 * therefore exactly the reads the route asked for.
 */
function countingLearningRepository(inner: LearningRepository): {
  readonly repo: LearningRepository;
  readonly calls: Map<string, number>;
} {
  const calls = new Map<string, number>();
  const repo = new Proxy(inner, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.set(String(prop), (calls.get(String(prop)) ?? 0) + 1);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as LearningRepository;
  return { repo, calls };
}

/**
 * ADR-0095 resolved step authorship by re-reading lesson → course after the step read. Both reads
 * had already happened inside `listSteps` / `getStep`, which resolve the same two rows to enforce
 * visibility — so the public step routes went from 3 SQL queries to 6 for a signed-in caller, with
 * the courses table read three times. Found in the PR review of #92.
 *
 * Counting the calls is the only way to see this: the responses were correct throughout, and every
 * shape and permission test passed while the query count doubled. Pinning it at one call means
 * re-introducing the second lookup fails here rather than being noticed in production latency.
 */
describe('Learning step reads make no redundant repository calls', () => {
  let harness: Harness;
  let calls: Map<string, number>;
  let author: { userId: string; token: string };
  let learner: { userId: string; token: string };
  let lessonId: string;
  let stepId: string;

  before(async () => {
    const counting = countingLearningRepository(new InMemoryLearningRepository());
    calls = counting.calls;
    harness = await startHarness({}, { learningRepository: counting.repo });
    author = await harness.makeUser('CountingAuthor');
    learner = await harness.makeUser('CountingLearner');

    const course = await harness.json('POST', '/v1/courses', {
      token: author.token,
      body: {
        slug: 'counting-course',
        title: 'Counting Course',
        description: 'For counting repository reads.',
        difficulty: 'beginner',
        published: true,
      },
    });
    assert.equal(course.status, 201);

    const lesson = await harness.json('POST', `/v1/courses/${course.body.id}/lessons`, {
      token: author.token,
      body: { title: 'Counting Lesson' },
    });
    assert.equal(lesson.status, 201);
    lessonId = lesson.body.id;

    const step = await harness.json('POST', `/v1/lessons/${lessonId}/steps`, {
      token: author.token,
      body: {
        kind: 'move',
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        expectedSan: 'e4',
        hint: 'Control center',
      },
    });
    assert.equal(step.status, 201);
    stepId = step.body.id;
  });

  after(async () => {
    if (harness) await harness.close();
  });

  // Both the author and a learner are checked: authorship is what the extra lookup existed to
  // decide, so a fix that only avoids the redundant read on one branch is not a fix.
  for (const who of ['author', 'learner'] as const) {
    it(`GET /v1/lessons/:id/steps reads the repository once for the ${who}`, async () => {
      const token = who === 'author' ? author.token : learner.token;
      calls.clear();

      const res = await harness.json('GET', `/v1/lessons/${lessonId}/steps`, { token });
      assert.equal(res.status, 200);

      assert.deepEqual([...calls], [['listStepsWithCourse', 1]]);
    });

    it(`GET /v1/steps/:id reads the repository once for the ${who}`, async () => {
      const token = who === 'author' ? author.token : learner.token;
      calls.clear();

      const res = await harness.json('GET', `/v1/steps/${stepId}`, { token });
      assert.equal(res.status, 200);

      assert.deepEqual([...calls], [['getStepWithCourse', 1]]);
    });
  }

  it('still tells the author and the learner apart', async () => {
    const asAuthor = await harness.json('GET', `/v1/steps/${stepId}`, { token: author.token });
    const asLearner = await harness.json('GET', `/v1/steps/${stepId}`, { token: learner.token });

    assert.equal(asAuthor.body.expectedSan, 'e4');
    assert.equal('expectedSan' in asLearner.body, false);
  });
});
