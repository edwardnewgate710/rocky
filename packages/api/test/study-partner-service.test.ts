import assert from 'node:assert/strict';
import test from 'node:test';
import { Position } from '@chess-platform/core';
import {
  InMemoryStudyPartnerRepository,
  STUDY_PARTNER_ACCEPTED_RECOVERY_MS,
  type StudyPartnerTurnRequestRef,
} from '@chess-platform/persistence';
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
}, repository = new InMemoryStudyPartnerRepository()) {
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
  const service = new StudyPartnerService({
    repository,
    coach: productionCoach,
    clock: { now: () => now },
    ids: { next: () => `00000000-0000-7000-8000-${String(++id).padStart(12, '0')}` },
  });
  return { service, calls, advance: (milliseconds: number) => { now += milliseconds; } };
}

class CleanupFailingStudyPartnerRepository extends InMemoryStudyPartnerRepository {
  override async failTurn(_ref: StudyPartnerTurnRequestRef): Promise<void> {
    throw new Error('cleanup unavailable');
  }
}

class AcceptanceRecordingStudyPartnerRepository extends InMemoryStudyPartnerRepository {
  acceptedAt: Date | undefined;

  override async acceptTurn(ref: StudyPartnerTurnRequestRef): Promise<boolean> {
    this.acceptedAt = ref.now;
    return super.acceptTurn(ref);
  }
}

class AcceptanceResponseLosingStudyPartnerRepository extends InMemoryStudyPartnerRepository {
  private loseNextResponse = true;

  override async acceptTurn(ref: StudyPartnerTurnRequestRef): Promise<boolean> {
    const accepted = await super.acceptTurn(ref);
    if (accepted && this.loseNextResponse) {
      this.loseNextResponse = false;
      throw new Error('accept response lost');
    }
    return accepted;
  }
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

test('deletion cannot erase a turn after production coaching has accepted it', async () => {
  let release: (() => void) | undefined;
  let accepted: (() => void) | undefined;
  const acceptedSignal = new Promise<void>((resolve) => { accepted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { service } = fixture({
    async coach(input, onAccepted) {
      if (onAccepted) await onAccepted();
      accepted?.();
      await gate;
      return quietOutcome(input);
    },
  });
  const created = await service.create('owner', 'standard', START);
  const submitted = service.submitTurn({
    ownerId: 'owner', sessionId: created.id, move: 'e2e4', expectedVersion: 0,
    idempotencyKey: 'delete-race', signal: new AbortController().signal,
    charge: async () => undefined,
  });
  await acceptedSignal;

  await assert.rejects(
    () => service.delete('owner', created.id),
    (error: unknown) => error instanceof HttpError && error.status === 409,
  );
  release?.();
  await submitted;
  await service.delete('owner', created.id);
  await assert.rejects(
    () => service.get('owner', created.id),
    (error: unknown) => error instanceof HttpError && error.status === 404,
  );
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

test('accepted-work protection starts when Coach accepts, not when the claim was created', async () => {
  const repository = new AcceptanceRecordingStudyPartnerRepository();
  let advanceClock: ((milliseconds: number) => void) | undefined;
  let accepted: (() => void) | undefined;
  let release: (() => void) | undefined;
  const acceptedSignal = new Promise<void>((resolve) => { accepted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { service, advance } = fixture({
    async coach(input, onAccepted) {
      advanceClock?.(60_000);
      if (onAccepted) await onAccepted();
      accepted?.();
      await gate;
      return quietOutcome(input);
    },
  }, repository);
  advanceClock = advance;
  const created = await service.create('owner', 'standard', START);

  const submitted = service.submitTurn({
    ownerId: 'owner', sessionId: created.id, move: 'e2e4', expectedVersion: 0,
    idempotencyKey: 'acceptance-time', signal: new AbortController().signal,
    charge: async () => undefined,
  });
  await acceptedSignal;

  assert.equal(repository.acceptedAt?.toISOString(), '2026-08-24T12:01:00.000Z');
  advance(STUDY_PARTNER_ACCEPTED_RECOVERY_MS - 60_000);
  await assert.rejects(
    () => service.delete('owner', created.id),
    (error: unknown) => error instanceof HttpError && error.status === 409,
  );
  release?.();
  await submitted;
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

test('a post-acceptance failure quarantines the session from every later turn purchase', async () => {
  let coachCalls = 0;
  const { service } = fixture({
    async coach(input, onAccepted) {
      coachCalls += 1;
      if (onAccepted) await onAccepted();
      if (input.move === 'e2e4') throw new Error('provider failed after acceptance');
      return quietOutcome(input);
    },
  });
  const created = await service.create('owner', 'standard', START);
  let charges = 0;
  const command = {
    ownerId: 'owner', sessionId: created.id, move: 'e2e4', expectedVersion: 0,
    idempotencyKey: 'failed-after-acceptance', signal: new AbortController().signal,
    charge: async () => { charges += 1; },
  };

  await assert.rejects(() => service.submitTurn(command), /provider failed after acceptance/);
  await assert.rejects(
    () => service.submitTurn({
      ...command,
      idempotencyKey: 'failed-after-acceptance-retry',
    }),
    (error: unknown) => error instanceof HttpError
      && error.status === 409
      && error.message.includes('cannot accept new turns'),
  );
  await assert.rejects(
    () => service.submitTurn({
      ...command,
      move: 'd2d4',
      idempotencyKey: 'alternative-intent',
    }),
    (error: unknown) => error instanceof HttpError
      && error.status === 409
      && error.message.includes('cannot accept new turns'),
  );
  const ended = await service.end('owner', created.id, 0);
  assert.equal(ended.status, 'completed');
  assert.equal(coachCalls, 1);
  assert.equal(charges, 1);
});

test('a slow accepted worker crossing recovery cannot race a second purchase', async () => {
  let accepted: (() => void) | undefined;
  let release: (() => void) | undefined;
  const acceptedSignal = new Promise<void>((resolve) => { accepted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let coachCalls = 0;
  const { service, advance } = fixture({
    async coach(input, onAccepted) {
      coachCalls += 1;
      if (onAccepted) await onAccepted();
      if (input.move === 'e2e4') {
        accepted?.();
        await gate;
      }
      return quietOutcome(input);
    },
  });
  const created = await service.create('owner', 'standard', START);
  let charges = 0;
  const first = service.submitTurn({
    ownerId: 'owner', sessionId: created.id, move: 'e2e4', expectedVersion: 0,
    idempotencyKey: 'slow-accepted', signal: new AbortController().signal,
    charge: async () => { charges += 1; },
  });
  await acceptedSignal;
  advance(STUDY_PARTNER_ACCEPTED_RECOVERY_MS);

  const secondResult = await service.submitTurn({
    ownerId: 'owner', sessionId: created.id, move: 'd2d4', expectedVersion: 0,
    idempotencyKey: 'different-after-recovery', signal: new AbortController().signal,
    charge: async () => { charges += 1; },
  }).then((result) => result, (error: unknown) => error);
  release?.();
  const firstResult = await first.then((result) => result, (error: unknown) => error);

  assert.ok(secondResult instanceof HttpError);
  assert.equal(secondResult.status, 409);
  assert.match(secondResult.message, /cannot accept new turns/);
  assert.ok(firstResult instanceof HttpError);
  assert.equal(firstResult.status, 409);
  assert.equal(coachCalls, 1);
  assert.equal(charges, 1);
});

test('a lost acceptance response cannot make the accepted intent purchasable again', async () => {
  const repository = new AcceptanceResponseLosingStudyPartnerRepository();
  const { service } = fixture(undefined, repository);
  const created = await service.create('owner', 'standard', START);
  let charges = 0;
  const command = {
    ownerId: 'owner', sessionId: created.id, move: 'e2e4', expectedVersion: 0,
    idempotencyKey: 'lost-acceptance', signal: new AbortController().signal,
    charge: async () => { charges += 1; },
  };

  await assert.rejects(() => service.submitTurn(command), /accept response lost/);
  await assert.rejects(
    () => service.submitTurn({ ...command, idempotencyKey: 'lost-acceptance-retry' }),
    (error: unknown) => error instanceof HttpError
      && error.status === 409
      && error.message.includes('cannot accept new turns'),
  );
  assert.equal(charges, 0);
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

test('a cleanup failure does not replace the original mapped turn error', async () => {
  const { service } = fixture(undefined, new CleanupFailingStudyPartnerRepository());
  const created = await service.create('owner', 'standard', START);
  await assert.rejects(
    () => service.submitTurn({
      ownerId: 'owner', sessionId: created.id, move: 'e2e5', expectedVersion: 0,
      idempotencyKey: 'cleanup-failure', signal: new AbortController().signal,
      charge: async () => undefined,
    }),
    (error: unknown) => error instanceof HttpError && error.status === 422,
  );
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
          moveOutcome: {
            kind: 'evaluation', evalKind: 'cp', evalValue: 0, evalLabel: '+0.00',
            providerSecret: 'forbidden-nested-explanation',
          },
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
    mistake: {
      kind: 'present',
      value: {
        fen: START,
        variant: 'standard',
        move: 'e2e4',
        classification: 'ok',
        before: { evalKind: 'cp', evalValue: 10, evalLabel: '+0.10' },
        after: {
          kind: 'evaluation', evalKind: 'cp', evalValue: 5, evalLabel: '+0.05',
          providerSecret: 'forbidden-nested-mistake',
        },
        centipawnLoss: 5,
        bestMove: 'e2e4',
        bestLine: ['e2e4'],
        depth: 12,
      },
    },
  });
  const serialized = JSON.stringify(projected);
  for (const forbidden of [
    'providerId', 'providerSecret', 'model', 'solutionMove', 'solutionLine', 'forbidden-',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('reading stored coaching rejects malformed present values and omission reasons', () => {
  const safe = studyPartnerCoaching(quietOutcome({ fen: START, variant: 'standard', move: 'e2e4' }));
  for (const section of ['mistake', 'explanation', 'opening', 'puzzle', 'endgame'] as const) {
    assert.throws(
      () => storedStudyPartnerCoaching({
        ...safe,
        [section]: { kind: 'present', value: {} },
      }),
      /invalid stored Study Partner coaching section/,
      section,
    );
    assert.throws(
      () => storedStudyPartnerCoaching({
        ...safe,
        [section]: { kind: 'omitted', reason: 'provider_secret' },
      }),
      /invalid stored Study Partner coaching section/,
      section,
    );
  }
});

test('reading stored coaching rejects malformed nested explanation citation data', () => {
  const safe = studyPartnerCoaching(quietOutcome({ fen: START, variant: 'standard', move: 'e2e4' }));
  assert.throws(
    () => storedStudyPartnerCoaching({
      ...safe,
      explanation: {
        kind: 'present',
        value: {
          fen: START,
          variant: 'standard',
          move: 'e2e4',
          explanation: 'Grounded prose.',
          citation: { bestLine: null },
        },
      },
    }),
    /invalid stored Study Partner coaching section/,
  );
});

test('reading stored coaching requires the terminal mistake label', () => {
  const safe = studyPartnerCoaching(quietOutcome({ fen: START, variant: 'standard', move: 'e2e4' }));
  assert.throws(
    () => storedStudyPartnerCoaching({
      ...safe,
      mistake: {
        kind: 'present',
        value: {
          fen: START,
          variant: 'standard',
          move: 'e2e4',
          classification: 'ok',
          before: { evalKind: 'mate', evalValue: 1, evalLabel: '#1' },
          after: { kind: 'terminal', reason: 'checkmate', result: '1-0' },
          centipawnLoss: null,
          bestMove: 'e2e4',
          bestLine: ['e2e4'],
          depth: 12,
        },
      },
    }),
    /invalid stored Study Partner coaching section/,
  );
});
