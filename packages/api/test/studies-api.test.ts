import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from './helpers.js';
import { MAX_PGN_BYTES } from '@chess-platform/studies';

describe('Studies REST API', () => {
  let harness: Harness;
  let owner: { userId: string; token: string };
  let player2: { userId: string; token: string };
  let player3: { userId: string; token: string };

  before(async () => {
    harness = await startHarness();
    owner = await harness.makeUser('StudyOwner');
    player2 = await harness.makeUser('StudyCollab');
    player3 = await harness.makeUser('StudyOutsider');
  });

  after(async () => {
    if (harness) {
      await harness.close();
    }
  });

  describe('Studies CRUD & Visibility', () => {
    let publicStudyId: string;
    let privateStudyId: string;

    it('creates public and private studies', async () => {
      const pubRes = await harness.json('POST', '/v1/studies', {
        token: owner.token,
        body: { name: 'Public Sicilian Study', description: 'Openings', visibility: 'public' },
      });
      assert.equal(pubRes.status, 201);
      assert.ok(pubRes.body.id);
      assert.equal(pubRes.body.ownerId, owner.userId);
      assert.equal(pubRes.body.visibility, 'public');
      publicStudyId = pubRes.body.id;

      const privRes = await harness.json('POST', '/v1/studies', {
        token: owner.token,
        body: { name: 'Private Repertoire', description: 'Secret', visibility: 'private' },
      });
      assert.equal(privRes.status, 201);
      assert.equal(privRes.body.visibility, 'private');
      privateStudyId = privRes.body.id;
    });

    it('returns 401 when creating study without auth', async () => {
      const res = await harness.json('POST', '/v1/studies', {
        body: { name: 'Unauthed Study', visibility: 'public' },
      });
      assert.equal(res.status, 401);
    });

    it('returns 422 for malformed study ID or invalid body', async () => {
      const res = await harness.json('GET', '/v1/studies/not-a-uuid');
      assert.equal(res.status, 422);

      const resBody = await harness.json('POST', '/v1/studies', {
        token: owner.token,
        body: { name: 'Invalid Vis', visibility: 'super_private' },
      });
      assert.equal(resBody.status, 422);
    });

    it('enforces visibility when fetching single study', async () => {
      // Owner can view private study
      const ownerFetch = await harness.json('GET', `/v1/studies/${privateStudyId}`, { token: owner.token });
      assert.equal(ownerFetch.status, 200);

      // Outsider receives 404 for private study
      const outsiderFetch = await harness.json('GET', `/v1/studies/${privateStudyId}`, { token: player3.token });
      assert.equal(outsiderFetch.status, 404);

      // Public study is visible to anonymous
      const anonFetch = await harness.json('GET', `/v1/studies/${publicStudyId}`);
      assert.equal(anonFetch.status, 200);
    });

    it('lists studies filtering by owner and search', async () => {
      const res = await harness.json('GET', `/v1/studies?ownerId=${owner.userId}&search=Sicilian`, { token: owner.token });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.items));
      assert.equal(res.body.items.length, 1);
      assert.equal(res.body.items[0].id, publicStudyId);
    });

    it('returns 404 when listing studies for non-existent owner', async () => {
      const nonExistentId = '018f3a5b-7c9d-7000-8000-999999999999';
      const res = await harness.json('GET', `/v1/studies?ownerId=${nonExistentId}`);
      assert.equal(res.status, 404);
    });

    it('updates study metadata', async () => {
      const patchRes = await harness.json('PATCH', `/v1/studies/${publicStudyId}`, {
        token: owner.token,
        body: { name: 'Updated Sicilian Study', description: 'Updated desc' },
      });
      assert.equal(patchRes.status, 200);
      assert.equal(patchRes.body.name, 'Updated Sicilian Study');

      // Outsider receives 403 trying to update
      const forbiddenRes = await harness.json('PATCH', `/v1/studies/${publicStudyId}`, {
        token: player3.token,
        body: { name: 'Hacked Title' },
      });
      assert.equal(forbiddenRes.status, 403);
    });

    it('deletes (tombstones) study', async () => {
      const delRes = await harness.json('DELETE', `/v1/studies/${privateStudyId}`, { token: owner.token });
      assert.equal(delRes.status, 200);
      assert.ok(delRes.body.deletedAt);

      // Subsequent fetch returns 404
      const fetchRes = await harness.json('GET', `/v1/studies/${privateStudyId}`, { token: owner.token });
      assert.equal(fetchRes.status, 404);
    });
  });

  describe('Collaborators & Ownership Transfer', () => {
    let studyId: string;

    before(async () => {
      const res = await harness.json('POST', '/v1/studies', {
        token: owner.token,
        body: { name: 'Collaborative Study', visibility: 'public' },
      });
      studyId = res.body.id;
    });

    it('adds collaborator to study', async () => {
      const res = await harness.json('POST', `/v1/studies/${studyId}/collaborators`, {
        token: owner.token,
        body: { playerId: player2.userId, role: 'contributor' },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.playerId, player2.userId);
      assert.equal(res.body.role, 'contributor');
    });

    it('returns 404 when adding non-existent player as collaborator', async () => {
      const nonExistentId = '018f3a5b-7c9d-7000-8000-999999999999';
      const res = await harness.json('POST', `/v1/studies/${studyId}/collaborators`, {
        token: owner.token,
        body: { playerId: nonExistentId, role: 'viewer' },
      });
      assert.equal(res.status, 404);
    });

    it('lists collaborators', async () => {
      const res = await harness.json('GET', `/v1/studies/${studyId}/collaborators`);
      assert.equal(res.status, 200);
      assert.equal(res.body.total, 2);
    });

    it('updates collaborator role', async () => {
      const res = await harness.json('PATCH', `/v1/studies/${studyId}/collaborators/${player2.userId}`, {
        token: owner.token,
        body: { role: 'viewer' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.role, 'viewer');
    });

    it('transfers ownership demoting old owner', async () => {
      // First promote player2 to contributor
      await harness.json('PATCH', `/v1/studies/${studyId}/collaborators/${player2.userId}`, {
        token: owner.token,
        body: { role: 'contributor' },
      });

      const res = await harness.json('POST', `/v1/studies/${studyId}/transfer-ownership`, {
        token: owner.token,
        body: { newOwnerId: player2.userId },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.oldOwner.playerId, owner.userId);
      assert.equal(res.body.oldOwner.role, 'contributor');
      assert.equal(res.body.newOwner.playerId, player2.userId);
      assert.equal(res.body.newOwner.role, 'owner');
    });

    it('removes collaborator', async () => {
      // player2 is now owner, owner is contributor. player2 can remove owner.
      const res = await harness.json('DELETE', `/v1/studies/${studyId}/collaborators/${owner.userId}`, {
        token: player2.token,
      });
      assert.equal(res.status, 204);
    });
  });

  describe('Chapters, Move Tree & PGN', () => {
    let studyId: string;
    let chapterId: string;
    let rootNodeId: string;

    before(async () => {
      const res = await harness.json('POST', '/v1/studies', {
        token: owner.token,
        body: { name: 'Tree & PGN Study', visibility: 'public' },
      });
      studyId = res.body.id;
    });

    it('creates chapter', async () => {
      const res = await harness.json('POST', `/v1/studies/${studyId}/chapters`, {
        token: owner.token,
        body: { name: 'Chapter 1: e4' },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.name, 'Chapter 1: e4');
      assert.equal(res.body.orderIndex, 0);
      chapterId = res.body.id;
    });

    it('rejects a starting FEN this server cannot parse, at the input rather than later', async () => {
      // A Three-Check FEN carries its counters where the halfmove clock belongs, so the codec
      // refuses to read one as standard. This particular study owns the standard rule set, so left
      // unvalidated the chapter would be created and fail on its first append. Raised in the Qodo
      // review of PR #140; see ADR-0120.
      //
      // Both spellings, and deliberately one of each length. The seven-field form is what an
      // analysis response actually emits, so it is the realistic paste; the six-field form has no
      // surplus field at all, so nothing but the counter itself can be what refuses it. Keeping
      // only the first would leave the test passing if the rejection ever came from a field-count
      // rule instead of the counter guard. Raised in the CodeRabbit review of PR #140.
      const pasted = [
        '4k3/8/8/8/8/8/8/3R3K w - - 2+3 17 42', // canonical, seven fields
        '4k3/8/8/8/8/8/8/3R3K w - - 2+3 17', // the counter alone, six fields
        '4k3/8/8/8/8/8/8/3R3K w - - 17 42 +1+0', // the trailing delivered spelling
      ];
      for (const startingFen of pasted) {
        const res = await harness.json('POST', `/v1/studies/${studyId}/chapters`, {
          token: owner.token,
          body: { name: 'pasted from an analysis panel', startingFen },
        });
        assert.equal(res.status, 422, `"${startingFen}" must not be stored`);
      }

      const listed = await harness.json('GET', `/v1/studies/${studyId}/chapters`);
      assert.equal(listed.body.items.length, 1, 'and no chapter is left behind');
    });

    it('rejects a starting FEN that parses but is not a chess position', async () => {
      // Parsing only proves the string decodes: an empty board and a position with no black king
      // both decode fine, and would be persisted and would accept moves. The shared validator adds
      // the king-count check. Raised in the Qodo review of PR #140.
      const notPositions = [
        '8/8/8/8/8/8/8/8 w - - 0 1', // an empty board
        'rnbq1bnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQ - 0 1', // no black king
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNK w - - 0 1', // two white kings, no black
      ];
      for (const startingFen of notPositions) {
        const res = await harness.json('POST', `/v1/studies/${studyId}/chapters`, {
          token: owner.token,
          body: { name: 'not a position', startingFen },
        });
        assert.equal(res.status, 422, `"${startingFen}" must not be stored`);
      }

      const listed = await harness.json('GET', `/v1/studies/${studyId}/chapters`);
      assert.equal(listed.body.items.length, 1, 'and none of them created a chapter');
    });

    it('rejects a PGN whose FEN header this server cannot parse, before any chapter exists', async () => {
      // The import path reached `createChapter` from inside the domain, underneath the input check on
      // the direct chapter route. A game with movetext hits the reader on its first SAN and was
      // always refused; a game with *none* was never parsed by anyone, so this returned 200 and
      // stored a chapter holding an unreadable FEN. Reproduced before the fix: status 200, one
      // chapter created, and every later append to it failed 422 — permanently unusable, from a
      // request that reported success. Raised in the CodeRabbit review of PR #140.
      const study = await harness.json('POST', '/v1/studies', {
        token: owner.token,
        body: { name: 'PGN FEN Header Study', visibility: 'public' },
      });
      const pgn = [
        '[Event "?"]',
        '[SetUp "1"]',
        '[FEN "4k3/8/8/8/8/8/8/3R3K w - - 2+3 17 42"]',
        '',
        '*',
        '',
      ].join('\n');

      const res = await harness.json('POST', `/v1/studies/${study.body.id}/import`, {
        token: owner.token,
        body: { pgn },
      });
      assert.equal(res.status, 422, 'the import is refused, not reported as a success');

      const listed = await harness.json('GET', `/v1/studies/${study.body.id}/chapters`);
      assert.equal(listed.body.items.length, 0, 'and no chapter is left behind to fail later');
    });

    it('still imports a PGN carrying an ordinary FEN header', async () => {
      // The guard must refuse an unreadable starting position, not every FEN header. A game with no
      // movetext is the case the guard newly reaches, so that is the case pinned here.
      const study = await harness.json('POST', '/v1/studies', {
        token: owner.token,
        body: { name: 'Ordinary FEN Header Study', visibility: 'public' },
      });
      const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
      const pgn = ['[Event "?"]', '[SetUp "1"]', `[FEN "${fen}"]`, '', '*', ''].join('\n');

      const res = await harness.json('POST', `/v1/studies/${study.body.id}/import`, {
        token: owner.token,
        body: { pgn },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.items.length, 1, 'one chapter');
      assert.equal(res.body.items[0].startingFen, fen, 'holding the position the PGN named');
    });

    it('still accepts an ordinary starting FEN', async () => {
      // In a study of its own: the chapters of `studyId` are a fixture the reorder test depends on,
      // and a test that quietly adds to another test's fixture is a test that breaks it later.
      const study = await harness.json('POST', '/v1/studies', {
        token: owner.token,
        body: { name: 'Starting FEN Study', visibility: 'public' },
      });
      const res = await harness.json('POST', `/v1/studies/${study.body.id}/chapters`, {
        token: owner.token,
        body: {
          name: 'from a real position',
          startingFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
        },
      });
      assert.equal(res.status, 201);
    });

    it('preserves Three-Check counters when a study appends a move', async () => {
      const study = await harness.json('POST', '/v1/studies', {
        token: owner.token,
        body: {
          name: 'Three-Check Study',
          visibility: 'public',
          variant: 'threecheck',
        },
      });
      assert.equal(study.status, 201);
      assert.equal(study.body.variant, 'threecheck');

      const chapter = await harness.json('POST', `/v1/studies/${study.body.id}/chapters`, {
        token: owner.token,
        body: {
          name: 'One check delivered',
          startingFen: '4k3/8/8/8/8/8/8/3R3K w - - 3+3 0 1',
        },
      });
      assert.equal(chapter.status, 201);

      const node = await harness.json(
        'POST',
        `/v1/studies/${study.body.id}/chapters/${chapter.body.id}/nodes`,
        {
          token: owner.token,
          body: { parentId: null, san: 'Re1+' },
        },
      );
      assert.equal(node.status, 201);
      assert.match(node.body.fenAfter, / 2\+3 1 1$/);
    });

    it('lists chapters', async () => {
      const res = await harness.json('GET', `/v1/studies/${studyId}/chapters`);
      assert.equal(res.status, 200);
      assert.equal(res.body.items.length, 1);
    });

    it('appends move node to chapter', async () => {
      const nodeRes = await harness.json('POST', `/v1/studies/${studyId}/chapters/${chapterId}/nodes`, {
        token: owner.token,
        body: { parentId: null, san: 'e4', comment: 'King pawn opening' },
      });
      assert.equal(nodeRes.status, 201);
      assert.equal(nodeRes.body.san, 'e4');
      assert.equal(nodeRes.body.comment, 'King pawn opening');
      rootNodeId = nodeRes.body.id;
    });

    it('returns 422 for illegal move append', async () => {
      const res = await harness.json('POST', `/v1/studies/${studyId}/chapters/${chapterId}/nodes`, {
        token: owner.token,
        body: { parentId: rootNodeId, san: 'Qxh7' }, // Qxh7 is illegal from 1. e4
      });
      assert.equal(res.status, 422);
    });

    it('annotates node', async () => {
      const patchRes = await harness.json('PATCH', `/v1/studies/${studyId}/nodes/${rootNodeId}`, {
        token: owner.token,
        body: { comment: 'Best move', nags: [1] },
      });
      assert.equal(patchRes.status, 200);
      assert.equal(patchRes.body.comment, 'Best move');
      assert.deepEqual(patchRes.body.nags, [1]);
    });

    it('gets chapter with move tree', async () => {
      const res = await harness.json('GET', `/v1/studies/${studyId}/chapters/${chapterId}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.chapter.id, chapterId);
      assert.equal(res.body.tree.length, 1);
      assert.equal(res.body.tree[0].id, rootNodeId);
    });

    it('reorders chapters', async () => {
      const ch2 = await harness.json('POST', `/v1/studies/${studyId}/chapters`, {
        token: owner.token,
        body: { name: 'Chapter 2: d4' },
      });

      const reorderRes = await harness.json('PUT', `/v1/studies/${studyId}/chapters/reorder`, {
        token: owner.token,
        body: { chapterIds: [ch2.body.id, chapterId] },
      });
      assert.equal(reorderRes.status, 200);
      assert.equal(reorderRes.body.items[0].id, ch2.body.id);
      assert.equal(reorderRes.body.items[1].id, chapterId);
    });

    it('imports PGN', async () => {
      const pgn = `[Event "Test Import"]
[Site "Shatarang"]
[Date "2026.08.02"]
[Round "1"]
[White "Player1"]
[Black "Player2"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0`;

      const importRes = await harness.json('POST', `/v1/studies/${studyId}/import`, {
        token: owner.token,
        body: { pgn },
      });
      assert.equal(importRes.status, 200);
      assert.ok(importRes.body.items.length >= 1);
    });

    it('enforces MAX_PGN_BYTES limit returning 413 for oversized PGN', async () => {
      const hugePgn = '1. e4 ' + ' '.repeat(MAX_PGN_BYTES + 100) + 'e5';
      const res = await harness.json('POST', `/v1/studies/${studyId}/import`, {
        token: owner.token,
        body: { pgn: hugePgn },
      });
      assert.equal(res.status, 413);
    });

    it('exports PGN text', async () => {
      const res = await fetch(`${harness.baseUrl}/v1/studies/${studyId}/export.pgn`);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('Event'));
    });

    it('deletes node and subtree', async () => {
      const delRes = await harness.json('DELETE', `/v1/studies/${studyId}/nodes/${rootNodeId}`, {
        token: owner.token,
      });
      assert.equal(delRes.status, 204);
    });

    it('deletes chapter', async () => {
      const delRes = await harness.json('DELETE', `/v1/studies/${studyId}/chapters/${chapterId}`, {
        token: owner.token,
      });
      assert.equal(delRes.status, 200);
      assert.ok(delRes.body.deletedAt);
    });
  });

  describe('503 Fallback when studiesRepository is omitted', () => {
    let unconfiguredHarness: Harness;

    before(async () => {
      unconfiguredHarness = await startHarness({}, { withoutStudies: true });
    });

    after(async () => {
      if (unconfiguredHarness) {
        await unconfiguredHarness.close();
      }
    });

    it('returns 503 for every studies route', async () => {
      const validUuid = '018f3a5b-7c9d-7000-8000-000000000001';
      const unauthedUser = await unconfiguredHarness.makeUser('UnconfigUser');

      const routes = [
        ['POST', '/v1/studies'],
        ['GET', '/v1/studies'],
        ['GET', `/v1/studies/${validUuid}`],
        ['PATCH', `/v1/studies/${validUuid}`],
        ['DELETE', `/v1/studies/${validUuid}`],
        ['POST', `/v1/studies/${validUuid}/collaborators`],
        ['GET', `/v1/studies/${validUuid}/collaborators`],
        ['PATCH', `/v1/studies/${validUuid}/collaborators/${validUuid}`],
        ['DELETE', `/v1/studies/${validUuid}/collaborators/${validUuid}`],
        ['POST', `/v1/studies/${validUuid}/transfer-ownership`],
        ['POST', `/v1/studies/${validUuid}/chapters`],
        ['GET', `/v1/studies/${validUuid}/chapters`],
        ['GET', `/v1/studies/${validUuid}/chapters/${validUuid}`],
        ['PATCH', `/v1/studies/${validUuid}/chapters/${validUuid}`],
        ['DELETE', `/v1/studies/${validUuid}/chapters/${validUuid}`],
        ['PUT', `/v1/studies/${validUuid}/chapters/reorder`],
        ['POST', `/v1/studies/${validUuid}/chapters/${validUuid}/nodes`],
        ['PATCH', `/v1/studies/${validUuid}/nodes/${validUuid}`],
        ['DELETE', `/v1/studies/${validUuid}/nodes/${validUuid}`],
        ['POST', `/v1/studies/${validUuid}/import`],
        ['GET', `/v1/studies/${validUuid}/export.pgn`],
      ];

      for (const [method, path] of routes) {
        const res = await unconfiguredHarness.json(method, path, { token: unauthedUser.token });
        assert.equal(res.status, 503, `Route ${method} ${path} should respond 503 when repo unconfigured`);
      }
    });
  });
});
