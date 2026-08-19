/**
 * Hermetic test suite for `StudyPartner`.
 *
 * Tests that:
 * - startSession creates and persists a session, returns a first step.
 * - submitTurn runs the Coach, appends the turn, and updates progress correctly.
 * - Session isolation: two sessions advanced independently do not corrupt each other.
 * - endSession produces a summary consistent with the recorded turns.
 * - Loading a non-existent session id → clean error.
 * - AI provider omitted → sessions/summaries valid with structured data and no narrative.
 * - The Study Partner calls the Coach (spy test).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { AnalysisProvider, AnalysisRequest, EngineResult, PlayRequest, PlayResult, EngineCapabilities } from '@chess-platform/engine';
import { FakeProvider } from '@chess-platform/ai-orchestrator';

import { StudyPartner, InMemoryStudySessionStore, computeProgress } from '../src/index.js';
import { Coach } from '../src/coach.js';
import type { CoachingResponse } from '../src/coach-types.js';
import type { StudySession, StudyTurn } from '../src/study-session-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Create a fake engine that returns a fixed eval. */
function createFakeEngine(evalCp: number = 200, bestMove: string = 'g1f3'): AnalysisProvider {
  return {
    async analyze(_request: AnalysisRequest): Promise<readonly EngineResult[]> {
      return [{
        multipv: 1,
        evaluation: { type: 'cp', value: evalCp },
        principalVariation: [bestMove],
        depth: 20, selDepth: 25, nodes: 1000000, nps: 500000, timeMs: 2000,
      }];
    },
    async play(_request: PlayRequest): Promise<PlayResult> { return { move: bestMove }; },
    capabilitiesFor(_variant: string): EngineCapabilities | undefined { return undefined; },
  };
}

/** Create a Coach backed by a fake engine + optional fake AI. */
function createCoach(engine?: AnalysisProvider, ai?: FakeProvider): Coach {
  return new Coach({
    engine: engine ?? createFakeEngine(),
    ...(ai ? { ai } : {}),
  });
}

/** Create a fake coaching response for testing. */
function fakeCoachingResponse(
  classification: 'ok' | 'inaccuracy' | 'mistake' | 'blunder' | null,
  featuresFired: readonly string[] = [],
): CoachingResponse {
  return {
    fen: STARTPOS,
    variant: 'standard',
    move: 'a2a3',
    featuresFired,
    mistakeVerdict: classification ? {
      fen: STARTPOS,
      move: 'a2a3',
      fenAfter: 'rnbqkbnr/pppppppp/8/8/8/P7/1PPPPPPP/RNBQKBNR b KQkq - 0 1',
      classification,
      centipawnLoss: classification === 'blunder' ? 400 : classification === 'mistake' ? 150 : classification === 'inaccuracy' ? 60 : 5,
      evalBefore: { type: 'cp', value: 200 },
      evalBeforeLabel: '+2.00',
      moveOutcome: {
        kind: 'evaluation',
        evaluation: { type: 'cp', value: classification === 'blunder' ? -200 : 50 },
        label: classification === 'blunder' ? '-2.00' : '+0.50',
      },
      betterMove: 'g1f3',
      bestLine: ['g1f3'],
      depth: 20,
      coaching: null,
      providerId: null,
      model: null,
      usage: null,
      latencyMs: null,
    } : null,
    moveExplanation: null,
    opening: null,
    puzzle: null,
    endgame: null,
    narrative: null,
    providerId: null,
    model: null,
    usage: null,
    latencyMs: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StudyPartner (hermetic)', () => {

  test('startSession creates and persists a session, returns a first step', async () => {
    const store = new InMemoryStudySessionStore();
    const coach = createCoach();
    const partner = new StudyPartner({ store, coach, idGenerator: () => 'test-1' });

    const result = await partner.startSession({ topic: 'Tactics' });

    assert.equal(result.session.id, 'test-1');
    assert.equal(result.session.topic, 'Tactics');
    assert.equal(result.session.status, 'active');
    assert.equal(result.session.turns.length, 0);
    assert.ok(result.currentFen);

    // Verify it was persisted.
    const loaded = await store.load('test-1');
    assert.ok(loaded);
    assert.equal(loaded!.topic, 'Tactics');
  });

  test('submitTurn runs the Coach, appends the turn, and updates progress correctly', async () => {
    // Submit 3 turns with known classifications, driven by a spy coach:
    //   Turn 1: ok
    //   Turn 2: blunder
    //   Turn 3: mistake
    let callCount = 0;
    const responses: CoachingResponse[] = [
      fakeCoachingResponse('ok', ['mistakePredictor']),
      fakeCoachingResponse('blunder', ['mistakePredictor', 'moveExplainer']),
      fakeCoachingResponse('mistake', ['mistakePredictor']),
    ];

    const spyCoach: Coach = {
      coach: async () => {
        const resp = responses[callCount++] ?? responses[responses.length - 1];
        return resp;
      },
    } as unknown as Coach;

    const store = new InMemoryStudySessionStore();
    const partner = new StudyPartner({ store, coach: spyCoach, idGenerator: () => 'test-2' });

    const started = await partner.startSession({ topic: 'Endgames' });
    const sessionId = started.session.id;

    const r1 = await partner.submitTurn({ sessionId, fen: STARTPOS, move: 'e2e4' });
    assert.equal(r1.progress.turnsCompleted, 1);
    assert.equal(r1.progress.okCount, 1);
    assert.equal(r1.progress.blunderCount, 0);

    const r2 = await partner.submitTurn({ sessionId, fen: STARTPOS, move: 'a2a3' });
    assert.equal(r2.progress.turnsCompleted, 2);
    assert.equal(r2.progress.okCount, 1);
    assert.equal(r2.progress.blunderCount, 1);

    const r3 = await partner.submitTurn({ sessionId, fen: STARTPOS, move: 'h2h4' });
    assert.equal(r3.progress.turnsCompleted, 3);
    assert.equal(r3.progress.okCount, 1);
    assert.equal(r3.progress.blunderCount, 1);
    assert.equal(r3.progress.mistakeCount, 1);

    // Accuracy = (1 ok + 0.5 * 0 inaccuracies) / 3 moves = 0.333
    assert.equal(r3.progress.accuracy, 1 / 3);
  });

  test('session isolation: two sessions advanced independently do not corrupt each other', async () => {
    // Use a counter-based id generator so each session gets a unique id.
    let counter = 0;
    const store = new InMemoryStudySessionStore();
    const coach = createCoach();
    const partner = new StudyPartner({
      store,
      coach,
      idGenerator: () => `iso-${++counter}`,
    });

    const a = await partner.startSession({ topic: 'Tactics' });
    const b = await partner.startSession({ topic: 'Endgames' });

    assert.notEqual(a.session.id, b.session.id);

    // Advance session A by one turn.
    await partner.submitTurn({ sessionId: a.session.id, fen: STARTPOS, move: 'e2e4' });

    // Session B should be unaffected.
    const bLoaded = await store.load(b.session.id);
    assert.ok(bLoaded);
    assert.equal(bLoaded!.turns.length, 0, 'Session B should have 0 turns');

    // Advance session B by one turn.
    await partner.submitTurn({ sessionId: b.session.id, fen: STARTPOS, move: 'd2d4' });

    // Session A should still have only 1 turn.
    const aLoaded = await store.load(a.session.id);
    assert.ok(aLoaded);
    assert.equal(aLoaded!.turns.length, 1, 'Session A should still have 1 turn');

    // Session B should now have 1 turn.
    const bLoaded2 = await store.load(b.session.id);
    assert.ok(bLoaded2);
    assert.equal(bLoaded2!.turns.length, 1, 'Session B should have 1 turn');

    // Progress should be independent.
    assert.equal(aLoaded!.progress.turnsCompleted, 1);
    assert.equal(bLoaded2!.progress.turnsCompleted, 1);
    assert.equal(aLoaded!.topic, 'Tactics');
    assert.equal(bLoaded2!.topic, 'Endgames');
  });

  test('endSession produces a summary consistent with the recorded turns', async () => {
    let counter = 0;
    const store = new InMemoryStudySessionStore();
    const coach = createCoach();
    const partner = new StudyPartner({ store, coach, idGenerator: () => `end-${++counter}` });

    await partner.startSession({ topic: 'Openings' });

    // Submit 2 turns.
    await partner.submitTurn({ sessionId: 'end-1', fen: STARTPOS, move: 'e2e4' });
    await partner.submitTurn({ sessionId: 'end-1', fen: STARTPOS, move: 'd2d4' });

    const result = await partner.endSession({ sessionId: 'end-1' });

    assert.equal(result.session.status, 'completed');
    assert.equal(result.session.turns.length, 2);
    assert.equal(result.progress.turnsCompleted, 2);
    assert.equal(result.summary.totalTurns, 2);
    assert.ok(result.summary.recommendedNextFocus.length > 0);
  });

  test('loading a non-existent session id → clean error', async () => {
    const store = new InMemoryStudySessionStore();
    const coach = createCoach();
    const partner = new StudyPartner({ store, coach, idGenerator: () => 'x' });

    await assert.rejects(
      () => partner.submitTurn({ sessionId: 'nonexistent', fen: STARTPOS, move: 'e2e4' }),
      /Session not found/,
    );

    await assert.rejects(
      () => partner.endSession({ sessionId: 'nonexistent' }),
      /Session not found/,
    );
  });

  test('AI provider omitted → sessions/summaries valid with structured data and no narrative', async () => {
    const store = new InMemoryStudySessionStore();
    const coach = createCoach(); // No AI
    const partner = new StudyPartner({ store, coach, idGenerator: () => 'no-ai' });

    const start = await partner.startSession({ topic: 'Tactics' });
    assert.equal(start.narrative, null);

    const turn = await partner.submitTurn({ sessionId: 'no-ai', fen: STARTPOS, move: 'e2e4' });
    assert.equal(turn.narrative, null);
    assert.ok(turn.coaching); // Structured data present
    assert.ok(turn.progress);

    const end = await partner.endSession({ sessionId: 'no-ai' });
    assert.equal(end.narrative, null);
    assert.equal(end.providerId, null);
    assert.ok(end.summary);
  });

  test('Study Partner calls the Coach (spy test)', async () => {
    let coachCalled = false;
    const spyCoach = {
      coach: async (_request: unknown) => {
        coachCalled = true;
        return fakeCoachingResponse('ok', ['mistakePredictor']);
      },
    } as unknown as Coach;

    const store = new InMemoryStudySessionStore();
    const partner = new StudyPartner({ store, coach: spyCoach, idGenerator: () => 'spy' });

    await partner.startSession({ topic: 'Test' });
    await partner.submitTurn({ sessionId: 'spy', fen: STARTPOS, move: 'e2e4' });

    assert.ok(coachCalled, 'StudyPartner should call Coach.coach');
  });

  test('with AI provider → narrative present', async () => {
    const store = new InMemoryStudySessionStore();
    const ai = new FakeProvider({ id: 'fake-ai', content: 'Study narrative.' });
    const coach = createCoach(undefined, ai);
    const partner = new StudyPartner({ store, coach, ai, idGenerator: () => 'with-ai' });

    const start = await partner.startSession({ topic: 'Tactics' });
    assert.ok(start.narrative);

    const turn = await partner.submitTurn({ sessionId: 'with-ai', fen: STARTPOS, move: 'e2e4' });
    assert.ok(turn.narrative);

    const end = await partner.endSession({ sessionId: 'with-ai' });
    assert.ok(end.narrative);
    assert.equal(end.providerId, 'fake-ai');
  });
});

// ---------------------------------------------------------------------------
// Pure function unit tests
// ---------------------------------------------------------------------------

describe('computeProgress', () => {

  test('empty turns → zero progress', () => {
    const p = computeProgress([]);
    assert.equal(p.turnsCompleted, 0);
    assert.equal(p.okCount, 0);
    assert.equal(p.accuracy, 1.0);
  });

  test('mixed classifications → correct counts and accuracy', () => {
    const turns: StudyTurn[] = [
      { turnNumber: 1, fen: '', move: 'e2e4', coaching: fakeCoachingResponse('ok'), mistakeClassification: 'ok', timestamp: '' },
      { turnNumber: 2, fen: '', move: 'a2a3', coaching: fakeCoachingResponse('blunder'), mistakeClassification: 'blunder', timestamp: '' },
      { turnNumber: 3, fen: '', move: 'h2h4', coaching: fakeCoachingResponse('inaccuracy'), mistakeClassification: 'inaccuracy', timestamp: '' },
    ];

    const p = computeProgress(turns);
    assert.equal(p.turnsCompleted, 3);
    assert.equal(p.okCount, 1);
    assert.equal(p.blunderCount, 1);
    assert.equal(p.inaccuracyCount, 1);
    // accuracy = (1 + 0.5 * 1) / 3 = 0.5
    assert.equal(p.accuracy, 0.5);
  });

  test('no-move turns counted separately', () => {
    const turns: StudyTurn[] = [
      { turnNumber: 1, fen: '', move: null, coaching: fakeCoachingResponse(null), mistakeClassification: null, timestamp: '' },
      { turnNumber: 2, fen: '', move: 'e2e4', coaching: fakeCoachingResponse('ok'), mistakeClassification: 'ok', timestamp: '' },
    ];

    const p = computeProgress(turns);
    assert.equal(p.turnsCompleted, 2);
    assert.equal(p.noMoveCount, 1);
    assert.equal(p.okCount, 1);
    // accuracy = 1 / 1 = 1.0 (only 1 turn with a move)
    assert.equal(p.accuracy, 1.0);
  });
});
