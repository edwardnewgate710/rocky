/**
 * The opening exploration service: what it identifies, what it refuses, and what it never publishes.
 *
 * The last of those is the reason the increment exists. `BundledOpeningDatabase` carries figures
 * like `{ games: 50000, whiteWins: 0.39 }` that its own header calls "approximate aggregate figures
 * for illustration … not sourced from a specific database" (ADR-0127). Nothing but the service's
 * projection stands between them and a client that would render them as measured win rates, so the
 * tests below assert their absence structurally rather than by inspecting one field.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BundledOpeningDatabase } from '@chess-platform/ai-features';
import { createOpeningExploration } from '../src/openings/composition.js';
import {
  MAX_EXPLORED_PLIES,
  OpeningExplorationService,
  STANDARD_START_FEN,
} from '../src/openings/opening-exploration-service.js';

/** 1.e4 e5 2.Nf3 Nc6 3.Bb5 — the deepest bundled top-level entry reachable in five plies. */
const RUY_LOPEZ = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'] as const;

/** @returns a service over the real bundled dataset — the thing production composes. */
function service(): OpeningExplorationService {
  return new OpeningExplorationService();
}

/** The HTTP status an `HttpError` carries, or `null` for anything else. */
function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

/**
 * Assert a refusal, and assert it is the *right* refusal.
 *
 * @param promise - the call under test.
 * @param messageIncludes - a fragment of the expected message. Checked because several refusals
 * share the 422 status, and a test that only counted the status would pass when the wrong rule
 * fired — which is exactly what distinguishes "too long" from "illegal".
 */
async function rejectsWith422(
  promise: Promise<unknown>,
  messageIncludes: string,
): Promise<void> {
  try {
    await promise;
    assert.fail(`expected a 422 mentioning "${messageIncludes}", but the call resolved`);
  } catch (error: unknown) {
    assert.equal(statusOf(error), 422, `expected 422, got ${String(error)}`);
    assert.match(String((error as Error).message), new RegExp(messageIncludes));
  }
}

test('a known move sequence is identified by ECO code and name', async () => {
  const outcome = await service().explore({ variant: 'standard', moves: [...RUY_LOPEZ] });
  assert.equal(outcome.found, true);
  assert.equal(outcome.eco, 'C60');
  assert.equal(outcome.name, 'Ruy Lopez (Spanish Opening)');
  assert.equal(outcome.matchedMoves, 5);
  assert.equal(outcome.outOfBook, false);
  assert.equal(outcome.continuations.length, 3);
  assert.deepEqual(outcome.moves, [...RUY_LOPEZ]);
});

test('play past the end of the identified line keeps the opening and reports out of book', async () => {
  const outcome = await service().explore({
    variant: 'standard',
    moves: [...RUY_LOPEZ, 'g8f6', 'e1g1'],
  });
  assert.equal(outcome.eco, 'C60', 'the line that was played is still the line that was played');
  assert.equal(outcome.matchedMoves, 5, 'the book covers five plies of the seven');
  assert.equal(outcome.outOfBook, true);
});

/**
 * Transpositions are not recognised, and this pins that rather than reporting it as a defect.
 *
 * `BundledOpeningDatabase.lookup` matches an entry whose moves are a *prefix of the submitted
 * sequence*; it never looks at the resulting position. The two sequences below reach an identical
 * board and get opposite answers. Recognising transpositions means a position-keyed index over a
 * real corpus, which is deferred with the statistics (ADR-0127) — so this test exists to make a
 * silent widening of the matcher visible, not to bless the limitation.
 */
test('a transposition into a known position is not identified, because lookup keys on the sequence', async () => {
  const direct = await service().explore({ variant: 'standard', moves: [...RUY_LOPEZ] });
  const transposed = await service().explore({
    variant: 'standard',
    moves: ['g1f3', 'b8c6', 'e2e4', 'e7e5', 'f1b5'],
  });
  assert.equal(direct.found, true, 'the book move order is identified');
  assert.equal(transposed.found, false, 'the same position by another order is not');
  assert.equal(transposed.eco, null);
});

test('an unknown opening returns a clean no-match rather than a nearest guess', async () => {
  const outcome = await service().explore({
    variant: 'standard',
    moves: ['a2a3', 'a7a6', 'h2h3'],
  });
  assert.deepEqual(outcome, {
    moves: ['a2a3', 'a7a6', 'h2h3'],
    found: false,
    eco: null,
    name: null,
    matchedMoves: 0,
    outOfBook: false,
    continuations: [],
  });
});

test('the starting position itself is a no-match, not an error', async () => {
  const outcome = await service().explore({ variant: 'standard', moves: [] });
  assert.equal(outcome.found, false);
  assert.equal(outcome.matchedMoves, 0);
});

/**
 * The bundled statistics never reach the caller.
 *
 * Three assertions rather than one, because each alone is weak. The string check catches a field
 * renamed into the payload; the key check catches a field added under another name; and the last
 * one proves the other two are evidence rather than tautology — the source entry for this exact
 * opening *does* carry `stats`, so if the projection stopped dropping them the first two would
 * start failing instead of continuing to pass over data that was never there.
 */
test('bundled opening statistics are dropped, and the source proves they were there to drop', async () => {
  const outcome = await service().explore({ variant: 'standard', moves: [...RUY_LOPEZ] });

  assert.doesNotMatch(JSON.stringify(outcome), /stats|games|whiteWins|draws|blackWins/);

  assert.deepEqual(Object.keys(outcome).sort(), [
    'continuations', 'eco', 'found', 'matchedMoves', 'moves', 'name', 'outOfBook',
  ]);
  for (const continuation of outcome.continuations) {
    assert.deepEqual(Object.keys(continuation).sort(), ['eco', 'move', 'name', 'san']);
  }

  const source = new BundledOpeningDatabase().allEntries.find((entry) => entry.eco === 'C60');
  assert.ok(source, 'the bundled dataset still carries the entry this test projects');
  assert.ok(source.stats, 'and it still carries the illustrative statistics being withheld');
  assert.ok(
    source.continuations.some((continuation) => continuation.stats !== undefined),
    'including on its continuations, which is the shape the projection has to strip',
  );
});

test('a variant other than standard is refused rather than answered from the standard book', async () => {
  await rejectsWith422(
    service().explore({ variant: 'crazyhouse', moves: ['e2e4'] }),
    'unsupported variant',
  );
  await rejectsWith422(
    service().explore({ variant: 'chess960', moves: ['e2e4'] }),
    'unsupported variant',
  );
});

test('a non-standard starting position is refused; the standard one may be stated explicitly', async () => {
  await rejectsWith422(
    service().explore({
      variant: 'standard',
      moves: ['e2e4'],
      initialFen: '8/8/8/8/8/8/8/K6k w - - 0 1',
    }),
    'unsupported starting position',
  );

  const stated = await service().explore({
    variant: 'standard',
    moves: [...RUY_LOPEZ],
    initialFen: STANDARD_START_FEN,
  });
  assert.equal(stated.eco, 'C60', 'naming the position the server assumes changes nothing');
});

test('a move that is not UCI is refused before any position is built', async () => {
  await rejectsWith422(service().explore({ variant: 'standard', moves: ['xx99'] }), 'malformed move');
  await rejectsWith422(service().explore({ variant: 'standard', moves: ['e2e']}), 'malformed move');
  await rejectsWith422(
    service().explore({ variant: 'standard', moves: ['e2e4', 'P@f7'] }),
    'malformed move',
    );
});

test('a well-formed but illegal sequence is refused as illegal, not as malformed', async () => {
  await rejectsWith422(
    service().explore({ variant: 'standard', moves: ['e2e4', 'e2e4'] }),
    'illegal move sequence',
  );
});

test('a sequence longer than the ceiling is refused rather than truncated to a prefix', async () => {
  await rejectsWith422(
    service().explore({
      variant: 'standard',
      moves: new Array<string>(MAX_EXPLORED_PLIES + 1).fill('e2e4'),
    }),
    'too long',
  );
});

/**
 * A sequence exactly at the ceiling passes the length gate.
 *
 * Asserted through the error it *does* get: `e2e4` repeated is illegal from move two, so the point
 * is that the refusal names illegality rather than length. Building a genuinely legal 60-ply game
 * here would test the rules engine instead of this gate.
 */
test('a sequence exactly at the ceiling is not refused for its length', async () => {
  await rejectsWith422(
    service().explore({
      variant: 'standard',
      moves: new Array<string>(MAX_EXPLORED_PLIES).fill('e2e4'),
    }),
    'illegal move sequence',
  );
});

/**
 * The ceiling has to leave room for the dataset.
 *
 * Computed from the bundled entries rather than written out, so shrinking `MAX_EXPLORED_PLIES`
 * below the deepest line — which would make that opening permanently unidentifiable — fails here
 * instead of silently narrowing what the feature can answer.
 */
test('the ply ceiling stays above the deepest bundled line, with room for out-of-book play', () => {
  const deepest = Math.max(
    ...new BundledOpeningDatabase().allEntries.map((entry) => entry.moves.length),
  );
  assert.ok(deepest > 0, 'the dataset is not empty');
  assert.ok(
    MAX_EXPLORED_PLIES > deepest,
    `the ceiling (${MAX_EXPLORED_PLIES}) must exceed the deepest bundled line (${deepest})`,
  );
});

test('composition yields a service for the bundled dataset', () => {
  assert.ok(createOpeningExploration() !== undefined);
});

/**
 * A build whose dataset is empty must not advertise the capability.
 *
 * `createOpeningExploration` takes no injection point on purpose — the bundled database is the one
 * it composes — so the emptiness rule it applies is asserted against the same condition here: an
 * empty `BundledOpeningDatabase` reports no entries, which is exactly what the factory checks.
 */
test('an empty opening database has nothing to identify, which is what composition gates on', async () => {
  const empty = new BundledOpeningDatabase([]);
  assert.equal(empty.allEntries.length, 0);

  const over = new OpeningExplorationService({ database: empty });
  const outcome = await over.explore({ variant: 'standard', moves: [...RUY_LOPEZ] });
  assert.equal(outcome.found, false, 'and it identifies nothing, hence the capability gate');
});
