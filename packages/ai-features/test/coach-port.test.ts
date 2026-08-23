/**
 * `CoachPort` — what `StudyPartner` and `VoiceCoach` require of a coach.
 *
 * Both used to take the concrete `Coach` class, so the only way to satisfy them was to build another
 * library `Coach` — which in production would bypass the policies `CoachService` applies (ADR-0129).
 * They call exactly one method between them, and that method is now all they ask for.
 *
 * The contract checks in this file are checked by `tsc`: each `AssertTrue` / `AssertFalse` alias
 * constrains a predicate to the answer it must give, so loosening a guarantee stops the build. The
 * runtime tests independently prove that both consumers operate through a bare port.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Coach } from '../src/coach.js';
import { StudyPartner, InMemoryStudySessionStore, VoiceCoach } from '../src/index.js';
import type { CoachPort } from '../src/index.js';
import type { CoachRequest, CoachingResponse } from '../src/coach-types.js';

/** `true` exactly when `A` is assignable to `B`; the tuple stops a union `A` from distributing. */
type IsAssignable<A, B> = [A] extends [B] ? true : false;

/** `true` when each type is assignable to the other. */
type IsExactly<A, B> = IsAssignable<A, B> extends true
  ? IsAssignable<B, A>
  : false;

type AssertTrue<T extends true> = T;
type AssertFalse<T extends false> = T;

/**
 * A coach that is only a coach.
 *
 * Deliberately not a `Coach` subclass and not a mock of one: if this satisfies both consumers, then
 * the port is genuinely all they need, which is the claim under test. It is also what a future
 * production adapter would look like from here.
 */
class FakeCoach implements CoachPort {
  readonly calls: CoachRequest[] = [];

  constructor(private readonly response: CoachingResponse) {}

  async coach(request: CoachRequest): Promise<CoachingResponse> {
    this.calls.push(request);
    return this.response;
  }
}

function emptyResponse(fen: string): CoachingResponse {
  return {
    fen,
    variant: 'standard',
    move: null,
    featuresFired: [],
    mistakeVerdict: null,
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

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// ── The contract, at compile time ───────────────────────────────────────────

/**
 * The concrete library `Coach` satisfies the port structurally.
 *
 * No `implements` clause on the class and no wrapper: it satisfies the port by having the method.
 * If it ever stops, this stops compiling — which is the only thing keeping the port honest, since a
 * port no implementation satisfies is worse than the class it replaced.
 */
type LibraryCoachSatisfiesThePort = AssertTrue<IsAssignable<Coach, CoachPort>>;

/**
 * The port is *not* the concrete class, which is the point of extracting it.
 *
 * `Coach` carries private implementation state, so this direction proves that a structural port is
 * not merely another name for the class. The consumer-constructor guards below are what prove that
 * neither dependency can be narrowed back to that class.
 */
type ThePortIsNotTheConcreteClass = AssertFalse<IsAssignable<CoachPort, Coach>>;

/** The capability remains exactly one operation wide. */
type ThePortHasExactlyOneOperation = AssertTrue<IsExactly<keyof CoachPort, 'coach'>>;

/** A partial implementation that only accepts standard chess cannot claim the full port. */
type StandardOnlyCoach = {
  readonly coach: (
    request: CoachRequest & { readonly variant: 'standard' },
  ) => Promise<CoachingResponse>;
};
type AStandardOnlyCoachIsNotThePort = AssertFalse<IsAssignable<StandardOnlyCoach, CoachPort>>;

/** A coach that is only a coach is enough for both consumers. */
type ABareCoachPortIsEnough = AssertTrue<IsAssignable<FakeCoach, CoachPort>>;

/**
 * Dropping the one required member is caught.
 *
 * `Omit<CoachPort, 'coach'>` is `{}`, and the guard is that `{}` is *not* a `CoachPort` — so a port
 * emptied of its operation stops satisfying itself.
 */
type APortWithoutCoachIsNotAPort = AssertFalse<
  IsAssignable<Omit<CoachPort, 'coach'>, CoachPort>
>;

/** And an unrelated shape does not accidentally satisfy it. */
type AnUnrelatedShapeIsNotAPort = AssertFalse<
  IsAssignable<{ readonly coach: string }, CoachPort>
>;

// ── The consumers, at runtime ───────────────────────────────────────────────

/**
 * The behavioural half: a `CoachPort` that is not a `Coach` drives a real session end to end.
 *
 * The compile-time predicates above say the types line up. This says the code does — that nothing
 * inside `StudyPartner` reaches for something only the concrete class has.
 */
test('StudyPartner runs a full turn against a bare CoachPort', async () => {
  const coach = new FakeCoach({ ...emptyResponse(START_FEN), featuresFired: ['opening'] });
  const partner = new StudyPartner({ store: new InMemoryStudySessionStore(), coach });

  const started = await partner.startSession({ topic: 'openings', initialFen: START_FEN });
  const turn = await partner.submitTurn({
    sessionId: started.session.id,
    fen: START_FEN,
    move: 'e2e4',
  });

  assert.equal(coach.calls.length, 1, 'the port is what the turn ran through');
  assert.equal(coach.calls[0]?.fen, START_FEN);
  assert.equal(coach.calls[0]?.move, 'e2e4');
  assert.equal(turn.coaching.featuresFired[0], 'opening');

  const ended = await partner.endSession({ sessionId: started.session.id });
  assert.equal(ended.summary.totalTurns, 1);
});

test('VoiceCoach verbalizes against a bare CoachPort', async () => {
  const coach = new FakeCoach({ ...emptyResponse(START_FEN), featuresFired: [] });
  const voice = new VoiceCoach({ coach });

  const spoken = await voice.coachAloud({ fen: START_FEN });

  assert.equal(coach.calls.length, 1, 'the port is what the request ran through');
  assert.equal(coach.calls[0]?.fen, START_FEN);
  assert.equal(spoken.coaching.fen, START_FEN);
  assert.ok(Array.isArray(spoken.segments));
});

/**
 * The port must stay the declared dependency, not merely a type that happens to fit today.
 *
 * `ConstructorParameters<...>[0]` reads the constructor's own parameter rather than naming a type
 * beside it. A consumer narrowed back to the concrete `Coach` would still accept a `Coach`, so
 * asserting that proves nothing. Asserting that it accepts a *bare port* is what a narrowing breaks — and it is the
 * mutation this file exists to catch.
 */
type StudyPartnerCoach =
  ConstructorParameters<typeof StudyPartner>[0] extends { readonly coach: infer C } ? C : never;
type VoiceCoachCoach =
  ConstructorParameters<typeof VoiceCoach>[0] extends { readonly coach: infer C } ? C : never;

type StudyPartnerTakesThePort = AssertTrue<IsAssignable<CoachPort, StudyPartnerCoach>>;
type VoiceCoachTakesThePort = AssertTrue<IsAssignable<CoachPort, VoiceCoachCoach>>;
