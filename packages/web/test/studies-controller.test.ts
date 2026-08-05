import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StudiesController } from '../src/app/studies-controller.js';
import { httpErrorFrom } from '../src/net/errors.js';
import type { ChapterView, StudyView, TreeNodeView } from '../src/api/models.js';

const STUDY: StudyView = {
  id: 'st1',
  ownerId: 'u1',
  name: 'Ruy Lopez Study',
  description: 'Classic Ruy Lopez lines.',
  visibility: 'public',
  createdAt: '2026-08-05T00:00:00Z',
  updatedAt: '2026-08-05T00:00:00Z',
};

const CHAPTER: ChapterView = {
  id: 'ch1',
  studyId: 'st1',
  name: 'Main Line',
  orderIndex: 0,
  startingFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
};

const NODE: TreeNodeView = {
  id: 'n1',
  chapterId: 'ch1',
  parentId: null,
  san: 'e4',
  fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
  nags: [1],
  orderIndex: 0,
};

function makeController(failWith: unknown = null) {
  let requests = 0;
  let loaded = 0;
  let unavailable = 0;
  const errors: string[] = [];

  const client = {
    studies: {
      listStudies: async () => {
        requests += 1;
        if (failWith !== null) throw failWith;
        return { total: 1, items: [STUDY] };
      },
      study: async () => {
        requests += 1;
        if (failWith !== null) throw failWith;
        return STUDY;
      },
      chapters: async () => {
        requests += 1;
        if (failWith !== null) throw failWith;
        return { items: [CHAPTER] };
      },
      chapterDetail: async () => {
        requests += 1;
        if (failWith !== null) throw failWith;
        return { chapter: CHAPTER, tree: [NODE] };
      },
      collaborators: async () => {
        requests += 1;
        if (failWith !== null) throw failWith;
        return { items: [] };
      },
      exportPgnUrl: (studyId: string, chapterId?: string) =>
        `/v1/studies/${studyId}/export.pgn${chapterId ? `?chapterId=${chapterId}` : ''}`,
    },
  };

  const controller = new StudiesController({
    client: client as never,
    callbacks: {
      onStudyList: () => {
        loaded += 1;
      },
      onStudy: () => {
        loaded += 1;
      },
      onChapterDetail: () => {
        loaded += 1;
      },
      onLoading: () => {},
      onError: (message) => {
        errors.push(message);
      },
      onUnavailable: () => {
        unavailable += 1;
      },
    },
  });

  const captured = {
    get loaded() {
      return loaded;
    },
    get unavailable() {
      return unavailable;
    },
    get errors() {
      return errors;
    },
    get requests() {
      return requests;
    },
  };

  return { controller, captured };
}

test('a deployment without studies service is asked once, then latches on 503', async () => {
  const { controller, captured } = makeController(httpErrorFrom(503, undefined));

  await controller.loadStudies();
  assert.equal(captured.unavailable, 1);
  assert.equal(captured.errors.length, 0);
  assert.equal(captured.loaded, 0);

  const afterFirstCall = captured.requests;

  // Subsequent calls immediately latch without making network requests
  await controller.loadStudies();
  await controller.loadStudy('st1');
  assert.equal(captured.requests, afterFirstCall);
  assert.equal(captured.unavailable, 3);
});

test('a server fault (500) is reported and does not stop subsequent requests', async () => {
  const { controller, captured } = makeController(httpErrorFrom(500, undefined));

  await controller.loadStudies();
  assert.equal(captured.errors.length, 1);
  assert.equal(captured.unavailable, 0);

  // Subsequent call still executes requests (does not latch on 500)
  await controller.loadStudies();
  assert.equal(captured.errors.length, 2);
  assert.equal(captured.requests, 2);
});

test('a foreign error carrying status 503 is reported rather than latching', async () => {
  const foreign = Object.assign(new Error('socket closed'), { status: 503 });
  const { controller, captured } = makeController(foreign);

  await controller.loadStudies();
  assert.equal(captured.unavailable, 0);
  assert.deepEqual(captured.errors, ['socket closed']);
});
