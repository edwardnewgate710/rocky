import assert from 'node:assert/strict';
import test from 'node:test';
import { Position } from '@chess-platform/core';
import { InMemoryStudyPartnerRepository } from '@chess-platform/persistence';
import type { CoachInput, CoachOutcome } from '../src/coach/coach-service.js';
import { HttpError } from '../src/http/errors.js';
import { storedStudyPartnerCoaching, studyPartnerCoaching } from '../src/study-partner/coaching.js';
import { StudyPartnerService } from '../src/study-partner/service.js';

const START = Position.initial('standard').fen();

const quietOutcome = (input: CoachInput): CoachOutcome => ({
  fen: input.fen,
  variant: input.variant,
  move: input.move ?? null,
  mistake: { kind: 'omitted', reason: 'not_applicable' },
  explanation: { kind: 'omitted', reason: 'not_applicable' },
  opening: { kind: 'omitted', reason: 'not_applicable' },
  puzzle: { kind: 'omitted', reason: 'not_applicable' },
  endgame: { kind: 'omitted', reason: 'not_applicable' },
  featuresFired: [],
});

function fixture(coach?: {
  coach(input: CoachInput, onAccepted?: () => Promise<void>): Promise<CoachOutcome>;
}) {
  let id = 0;
  let now = Date.parse('2026-08-24T12:00:00.000Z');
  const calls: CoachInput[] = [];
  const productionCoach = coach ?? {
    async coach(input: CoachInput, onAccepted?: () => Promise<void>): Promise<CoachOutcome> {
      calls.push(input);
      if (onAccepted) await onAccepted();
      return quietOutcome(input);
    },
  };
  const repository = new InMemoryStudyPartnerRepository();
  const service = new StudyPartnerService({
    repository,
    coach: productionCoach,
    clock: { now: () => now },
    ids: { next: () => `00000000-0000-7000-8000-${String(++id).padStart(12, '0')}` },
  });
  return { service, calls, advance: (milliseconds: number) => { now += milliseconds; } };
}

test('the server applies a turn to its authoritative FEN and replays it without coaching twice', async () => {
  const { service, calls } = fixture();
  const created = await service.create('owner', 'standard', START);
  let charges = 0;
  const command = {
    ownerId: 'owner',
    sessionId: created.id,
    move: 'e2e4',
    expectedVersion: 0,
    idempotencyKey: 'turn-1',
    signal: new AbortController().signal,
    charge: async () => { charges += 1; },
  };

  const first = await service.submitTurn(command);
  const replay = await service.submitTurn(command);

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.turn, first.turn);
  assert.equal(charges, 1);
  assert.equal(calls.length, 1);
  assert.equal(first.turn.fenBefore, START);
  assert.equal(first.turn.fenAfter, Position.fromFen(START).play('e2e4').fen());
  assert.equal((await service.get('owner', created.id)).currentFen, first.turn.fenAfter);
});

test('a concurrent retry sees the durable claim and cannot buy a second coaching run', async () => {
  let release: (() => void) | undefined;
  let accepted: (() => void) | undefined;
  const acceptedSignal = new Promise<void>((resolve) => { accepted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let coachCalls = 0;
  const { service } = fixture({
    async coach(input, onAccepted) {
      coachCalls += 1;
      if (onAccepted) await onAccepted();
      accepted?.();
      await gate;
      return quietOutcome(input);
    },
  });
  const created = await service.create('owner', 'standard', START);
  let charges = 0;
  const command = {
    ownerId: 'owner', sessionId: created.id, move: 'e2e4', expectedVersion: 0,
    idempotencyKey: 'concurrent', signal: new AbortController().signal,
    charge: async () => { charges += 1; },
  };
  const first = service.submitTurn(command);
  await acceptedSignal;

  await assert.rejects(
    () => service.submitTurn({ ...command, signal: new AbortController().signal }),
    (error: unknown) => error instanceof HttpError && error.status === 409,
  );
  release?.();
  await first;
  assert.equal(coachCalls, 1);
  assert.equal(charges, 1);
});

test('two different intents for one version cannot both enter production coaching', async () => {
  let release: (() => void) | undefined;
  let accepted: (() => void) | undefined;
  const acceptedSignal = new Promise<void>((resolve) => { accepted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let coachCalls = 0;
  const { service } = fixture({
    async coach(input, onAccepted) {
      coachCalls += 1;
      if (onAccepted) await onAccepted();
      accepted?.();
      await gate;
      return quietOutcome(input);
    },
  });
  const created = await service.create('owner', 'standard', START);
  const common = {
    ownerId: 'owner', sessionId: created.id, expectedVersion: 0,
    signal: new AbortController().signal, charge: async () => undefined,
  };
  const first = service.submitTurn({ ...common, move: 'e2e4', idempotencyKey: 'intent-a' });
  await acceptedSignal;
  await assert.rejects(
    () => service.submitTurn({ ...common, move: 'd2d4', idempotencyKey: 'intent-b' }),
    (error: unknown) => error instanceof HttpError && error.status === 409,
  );
  release?.();
  await first;
  assert.equal(coachCalls, 1);
});

test('a repeated Coach acceptance callback cannot charge the same turn twice', async () => {
  const { service } = fixture({
    async coach(input, onAccepted) {
      if (onAccepted) {
        await onAccepted();
        await onAccepted();
      }
      return quietOutcome(input);
    },
  });
  const created = await service.create('owner', 'standard', START);
  let charges = 0;
  await assert.rejects(
    () => service.submitTurn({
      ownerId: 'owner', sessionId: created.id, move: 'e2e4', expectedVersion: 0,
      idempotencyKey: 'one-shot-acceptance', signal: new AbortController().signal,
      charge: async () => { charges += 1; },
    }),
    (error: unknown) => error instanceof HttpError && error.status === 409,
  );
  assert.equal(charges, 1);
  assert.equal((await service.get('owner', created.id)).turnCount, 0);
});

test('foreign ownership is indistinguishable from a missing session', async () => {
  const { service } = fixture();
  const created = await service.create('owner', 'standard', START);
  for (const id of [created.id, '00000000-0000-7000-8000-999999999999']) {
    await assert.rejects(
      () => service.get('stranger', id),
      (error: unknown) => error instanceof HttpError && error.status === 404,
    );
  }
});

test('cancellation after charging does not persist or advance and exhausts that key', async () => {
  const controller = new AbortController();
  let coachCalls = 0;
  const { service } = fixture({
    async coach(input, onAccepted) {
      coachCalls += 1;
      if (onAccepted) await onAccepted();
      controller.abort();
      return quietOutcome(input);
    },
  });
  const created = await service.create('owner', 'standard', START);
  let charges = 0;
  const command = {
    ownerId: 'owner', sessionId: created.id, move: 'e2e4', expectedVersion: 0,
    idempotencyKey: 'cancelled', signal: controller.signal,
    charge: async () => { charges += 1; },
  };
  await assert.rejects(() => service.submitTurn(command), { name: 'AbortError' });
  const unchanged = await service.get('owner', created.id);
  assert.equal(unchanged.version, 0);
  assert.equal(unchanged.turnCount, 0);
  assert.equal(unchanged.currentFen, START);
  await assert.rejects(
    () => service.submitTurn({ ...command, signal: new AbortController().signal }),
    (error: unknown) => error instanceof HttpError && error.status === 409,
  );
  assert.equal(coachCalls, 1);
  assert.equal(charges, 1);
});

test('a request already cancelled never reaches Coach or quota and persists no turn', async () => {
  let coachCalls = 0;
  const { service } = fixture({
    async coach(input, onAccepted) {
      coachCalls += 1;
      if (onAccepted) await onAccepted();
      return quietOutcome(input);
    },
  });
  const created = await service.create('owner', 'standard', START);
  const controller = new AbortController();
  controller.abort();
  let charges = 0;
  await assert.rejects(
    () => service.submitTurn({
      ownerId: 'owner', sessionId: created.id, move: 'e2e4', expectedVersion: 0,
      idempotencyKey: 'already-cancelled', signal: controller.signal,
      charge: async () => { charges += 1; },
    }),
    { name: 'AbortError' },
  );
  assert.equal(coachCalls, 0);
  assert.equal(charges, 0);
  assert.equal((await service.get('owner', created.id)).turnCount, 0);
});

test('a fabricated Coach result for another move is discarded before commit', async () => {
  const { service } = fixture({
    async coach(input, onAccepted) {
      if (onAccepted) await onAccepted();
      return { ...quietOutcome(input), move: 'd2d4' };
    },
  });
  const created = await service.create('owner', 'standard', START);
  await assert.rejects(
    () => service.submitTurn({
      ownerId: 'owner', sessionId: created.id, move: 'e2e4', expectedVersion: 0,
      idempotencyKey: 'fabricated', signal: new AbortController().signal,
      charge: async () => undefined,
    }),
    /another position or move/,
  );
  const unchanged = await service.get('owner', created.id);
  assert.equal(unchanged.version, 0);
  assert.equal(unchanged.turnCount, 0);
});

test('ending is idempotent and does not rewrite completedAt', async () => {
  const { service, advance } = fixture();
  const created = await service.create('owner', 'standard', START);
  const ended = await service.end('owner', created.id, 0);
  advance(60_000);
  const repeated = await service.end('owner', created.id, 0);
  assert.equal(ended.status, 'completed');
  assert.equal(repeated.version, ended.version);
  assert.equal(repeated.completedAt?.toISOString(), ended.completedAt?.toISOString());
});

test('the persisted explanation projection drops provider and model metadata', () => {
  const coaching = studyPartnerCoaching({
    ...quietOutcome({ fen: START, variant: 'standard', move: 'e2e4' }),
    explanation: {
      kind: 'present',
      value: {
        fen: START,
        variant: 'standard',
        move: 'e2e4',
        explanation: 'Develops a central pawn.',
        citation: {
          moveOutcome: { kind: 'evaluation', evalKind: 'cp', evalValue: 10, evalLabel: '+0.10' },
          evalKind: 'cp',
          evalValue: 20,
          evalLabel: '+0.20',
          bestMove: 'e2e4',
          bestLine: ['e2e4'],
          depth: 14,
        },
        providerId: 'must-not-persist',
        model: 'must-not-persist',
      },
    },
  });
  const serialized = JSON.stringify(coaching);
  assert.equal(serialized.includes('must-not-persist'), false);
  assert.equal(serialized.includes('providerId'), false);
  assert.equal(serialized.includes('model'), false);
});

test('reading stored coaching strips forbidden fields instead of reflecting raw JSONB', () => {
  const safe = studyPartnerCoaching(quietOutcome({ fen: START, variant: 'standard', move: 'e2e4' }));
  const projected = storedStudyPartnerCoaching({
    ...safe,
    explanation: {
      kind: 'present',
      value: {
        fen: START,
        variant: 'standard',
        move: 'e2e4',
        explanation: 'Grounded prose.',
        citation: {
          moveOutcome: { kind: 'evaluation', evalKind: 'cp', evalValue: 0, evalLabel: '+0.00' },
          evalKind: 'cp', evalValue: 10, evalLabel: '+0.10', bestMove: 'e2e4', bestLine: [], depth: 12,
        },
        providerId: 'forbidden-provider',
        model: 'forbidden-model',
      },
    },
    puzzle: {
      kind: 'present',
      value: {
        kind: 'puzzle', fen: START, variant: 'standard', difficulty: 'easy',
        solutionMove: 'e2e4', solutionLine: ['e2e4'],
      },
    },
  });
  const serialized = JSON.stringify(projected);
  for (const forbidden of ['providerId', 'model', 'solutionMove', 'solutionLine', 'forbidden-']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
