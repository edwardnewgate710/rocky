/**
 * Contract tests for the chaos suite's decision logic (`scripts/lib/chaos-plan.mjs`, ADR-0077).
 *
 * `scripts/chaos-test.mjs` cannot be imported here — importing it starts a run against a live
 * two-node stack — so the guards that decide whether a run proved anything are exercised directly,
 * the same split `ws-baseline-plan.test.mjs` uses for the k6 scenario.
 *
 * Each test below stands for a way the suite could have reported success while testing nothing: a
 * survivor "confirmed" as the new owner by a game an earlier scenario left it, a sleep that stopped
 * matching the lease it was derived from, an induced failure that was really the client giving up
 * first, a cluster that was two isolated nodes, and a regression filed as a signed-off defect.
 *
 * They live under `deploy/load/test/` because that is what `npm run test:load-harness` runs in CI,
 * which is the gate this logic has to pass through — the chaos run itself needs a stack and stays
 * on `workflow_dispatch`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FORWARD_TIMEOUT_MS,
  KNOWN_OPEN_DEFECTS,
  classifyExit,
  classifyInducedOutcome,
  inducedFailureBudgetMs,
  inducedFailureVerdict,
  leaseTiming,
  ownershipFromCounts,
  ownershipHeldProblem,
  ownershipTakeoverProblem,
  topologyProblems,
} from '../../../scripts/lib/chaos-plan.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (relative) => readFileSync(join(REPO_ROOT, relative), 'utf8');

/** The lease numbers `docker-compose.chaos.yml` actually runs the stack with. */
const CHAOS_DEFAULTS = { leaseTtlSec: 6, renewalIntervalSec: 2 };

// ─────────────────────────────────────────────────────────────────────────────
// Timing is derived from the stack, not restated beside it
// ─────────────────────────────────────────────────────────────────────────────

test('every chaos deadline is derived from the lease the stack actually runs with', () => {
  const compose = read('docker-compose.chaos.yml');
  const ttl = /OWNERSHIP_LEASE_TTL_SEC:\s*"(\d+)"/.exec(compose);
  const renewal = /OWNERSHIP_RENEWAL_INTERVAL_SEC:\s*"(\d+)"/.exec(compose);
  assert.ok(ttl && renewal, 'docker-compose.chaos.yml no longer states the ownership lease numbers');

  assert.deepEqual(
    { leaseTtlSec: Number(ttl[1]), renewalIntervalSec: Number(renewal[1]) },
    CHAOS_DEFAULTS,
    'the compose stack changed its lease configuration; scripts/chaos-test.mjs reads these as its ' +
      'defaults, so every wait it derives would now describe a differently configured service',
  );

  const script = read('scripts/chaos-test.mjs');
  assert.match(
    script,
    /const TIMING = leaseTiming\(/,
    'the chaos suite must derive its waits rather than hardcode them',
  );
  for (const literal of ['7000', '3000)', 'setTimeout(r, 7000']) {
    assert.ok(
      !script.includes(literal),
      `the chaos suite still contains the literal wait ${literal}; a sleep beside a lease it is ` +
        'not derived from stops testing what it claims the moment the lease changes',
    );
  }
});

test('the graceful-drain budget is strictly under the TTL it is meant to beat', () => {
  const timing = leaseTiming(CHAOS_DEFAULTS);
  assert.ok(
    timing.gracefulFailoverBudgetMs < timing.leaseTtlMs,
    'a drain budget at or above the lease TTL is met by simply waiting for expiry, which is the ' +
      'ungraceful path — the scenario would assert nothing about the release having run',
  );
  assert.ok(
    timing.gracefulObservationWindowMs > timing.gracefulFailoverBudgetMs,
    'watching for exactly as long as the budget makes the budget check unreachable: the wait times ' +
      'out first and a merely-slow failover reports a timeout instead of its duration',
  );
  assert.equal(timing.gracefulFailoverBudgetMs, 5000, 'unchanged at the stack’s default 6s TTL');
});

test('the ungraceful wait outlasts the lease, and the fast-path wait outlasts the window', () => {
  const timing = leaseTiming(CHAOS_DEFAULTS);
  assert.ok(
    timing.ungracefulFailoverWaitMs > timing.leaseTtlMs,
    'a SIGKILL releases nothing, so a successor cannot claim before the key expires',
  );
  assert.ok(
    timing.fastPathExpiryWaitMs > timing.fastPathWindowMs,
    'the owner is still inside its window until this elapses, so a move accepted before it proves ' +
      'nothing about failing closed',
  );
  assert.equal(timing.fastPathWindowMs, 3600, 'ADR-0078 safety margin over the stack default');
});

test('at the stack’s own lease, every derived deadline equals the literal it replaced', () => {
  const timing = leaseTiming(CHAOS_DEFAULTS);
  assert.deepEqual(
    {
      ungraceful: timing.ungracefulFailoverWaitMs,
      graceful: timing.gracefulFailoverBudgetMs,
      fastPathExpiry: timing.fastPathExpiryWaitMs,
    },
    { ungraceful: 7000, graceful: 5000, fastPathExpiry: 5100 },
    'deriving these is meant to stop them drifting from the lease, not to quietly retune a suite ' +
      'nobody has re-run; at the default 6s/2s configuration the numbers are unchanged',
  );
});

test('lease timing scales with the configuration instead of staying pinned to the default', () => {
  const doubled = leaseTiming({ leaseTtlSec: 12, renewalIntervalSec: 4 });
  const base = leaseTiming(CHAOS_DEFAULTS);
  assert.ok(
    doubled.ungracefulFailoverWaitMs > base.ungracefulFailoverWaitMs &&
      doubled.fastPathWindowMs > base.fastPathWindowMs &&
      doubled.gracefulFailoverBudgetMs > base.gracefulFailoverBudgetMs,
    'every derived deadline must move with the lease; one that does not is a literal in disguise',
  );
});

test('a lease configuration with no fast-path window is refused, not silently measured', () => {
  assert.throws(() => leaseTiming({ leaseTtlSec: 2, renewalIntervalSec: 2 }), /must be below/);
  assert.throws(() => leaseTiming({ leaseTtlSec: 0, renewalIntervalSec: 1 }), /positive number/);
  assert.throws(() => leaseTiming({ leaseTtlSec: 6, renewalIntervalSec: 0 }), /positive number/);
});

// ─────────────────────────────────────────────────────────────────────────────
// An induced failure has to be witnessed, not assumed
// ─────────────────────────────────────────────────────────────────────────────

test('a command issued into an outage is watched past the gateway’s own decision window', () => {
  assert.ok(
    inducedFailureBudgetMs(FORWARD_TIMEOUT_MS) > FORWARD_TIMEOUT_MS,
    'the suite waited 3000ms against the gateway’s 5000ms forwarding timeout, so every "failed as ' +
      'expected" it reported was the client giving up first and would have read the same if the ' +
      'gateway were about to accept the command',
  );
  assert.match(
    read('scripts/chaos-test.mjs'),
    /inducedFailureBudgetMs\(FORWARD_TIMEOUT_MS\)/,
    'the Redis-outage assertions must use the derived budget, not a literal',
  );
});

test('an accepted command during an induced outage fails the scenario', () => {
  const outcome = classifyInducedOutcome({ accepted: true, rejectCode: null });
  assert.equal(outcome.kind, 'accepted');
  assert.match(
    inducedFailureVerdict(outcome, 'a non-owner move'),
    /ACCEPTED/,
    'applying a command the outage should have blocked is the failure this scenario exists to catch',
  );
});

test('a refusal and a silence both hold, and are recorded as the different evidence they are', () => {
  const rejected = classifyInducedOutcome({ accepted: false, rejectCode: 'invalid_command' });
  const silent = classifyInducedOutcome({ accepted: false, rejectCode: null });

  assert.deepEqual(
    [rejected.kind, rejected.code],
    ['rejected', 'invalid_command'],
    'an explicit reject is the strong result and its code belongs in the evidence',
  );
  assert.deepEqual([silent.kind, silent.code], ['silent', null]);
  assert.equal(inducedFailureVerdict(rejected, 'x'), null);
  assert.equal(
    inducedFailureVerdict(silent, 'x'),
    null,
    'with Redis gone there may be nothing left to answer with, so silence is legitimate — but it ' +
      'is also what a broken harness produces, which is why it is not relabelled as a refusal',
  );
  assert.notEqual(rejected.kind, silent.kind, 'the two must stay distinguishable in the artifact');
});

// ─────────────────────────────────────────────────────────────────────────────
// Ownership is a delta, never a raw count
// ─────────────────────────────────────────────────────────────────────────────

test('the node that claimed this game is the one whose count grew', () => {
  assert.deepEqual(ownershipFromCounts({ n1: 3, n2: 5 }, { n1: 4, n2: 5 }), {
    owner: 1,
    nonOwner: 2,
  });
  assert.deepEqual(ownershipFromCounts({ n1: 3, n2: 5 }, { n1: 3, n2: 6 }), {
    owner: 2,
    nonOwner: 1,
  });
  assert.equal(
    ownershipFromCounts({ n1: 0, n2: 0 }, { n1: 0, n2: 0 }),
    null,
    'no growth yet is "keep polling", because the claim races the command that triggers it',
  );
  assert.equal(
    ownershipFromCounts({ n1: 0, n2: 0 }, { n1: 1, n2: 1 }),
    null,
    'two nodes both claiming is not an owner; a run that picked one would be reporting a guess',
  );
});

test('a survivor that merely already owned a game has not been shown to take one over', () => {
  // What the failover scenarios used to assert, in the state the previous scenario leaves behind:
  // node2 owns the game the SIGKILL scenario handed it, so `ownedGames >= 1` on node2 is already
  // true when the graceful-drain scenario begins.
  const beforeDrain = { n1: 1, n2: 1 };
  assert.ok(
    beforeDrain.n2 >= 1,
    'the raw check the suite used to make is satisfied before the scenario does anything',
  );
  assert.match(
    ownershipTakeoverProblem(beforeDrain, { n1: 1, n2: 1 }, 2),
    /no more than the 1 it owned before this scenario began/,
    'the delta check must refuse the same state the raw check accepted',
  );
  assert.equal(
    ownershipTakeoverProblem(beforeDrain, { n1: 0, n2: 2 }, 2),
    null,
    'a genuine takeover shows up as growth against the baseline',
  );
});

test('a peer’s departure must move the owner’s lease in neither direction', () => {
  assert.equal(ownershipHeldProblem({ n1: 1, n2: 0 }, { n1: 1, n2: 0 }, 1), null);
  assert.match(
    ownershipHeldProblem({ n1: 1, n2: 0 }, { n1: 0, n2: 0 }, 1),
    /must not move the owner's lease/,
    'the owner dropping a game when an unrelated node dies is the failure this scenario adds',
  );
  assert.match(
    ownershipHeldProblem({ n1: 1, n2: 1 }, { n1: 2, n2: 0 }, 1),
    /must not move the owner's lease/,
    'a re-claim is a lease that was released first, which is equally wrong',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// The stack in front of the suite has to be the one it tests
// ─────────────────────────────────────────────────────────────────────────────

const node = (overrides = {}) => ({
  name: 'node1',
  wsUrl: 'ws://localhost:4175',
  healthUrl: 'http://localhost:4176/health',
  metricsUrl: 'http://localhost:4176/metrics',
  health: { commandRouting: 'redis' },
  ...overrides,
});

const peer = (overrides = {}) =>
  node({
    name: 'node2',
    wsUrl: 'ws://localhost:4177',
    healthUrl: 'http://localhost:4178/health',
    metricsUrl: 'http://localhost:4178/metrics',
    ...overrides,
  });

test('a two-node stack routing through Redis is accepted', () => {
  assert.deepEqual(topologyProblems([node(), peer()]), []);
});

test('two gateways routing locally are refused, however healthy they look', () => {
  const problems = topologyProblems([node({ health: { commandRouting: 'local' } }), peer()]);
  assert.equal(problems.length, 1);
  assert.match(
    problems[0],
    /nothing would ever be forwarded/,
    'both nodes answer every health check and serve every socket in this configuration, and each ' +
      'owns every game it is asked about — a cluster-shaped run over two isolated deployments',
  );
});

test('one node behind two names is refused before anything is killed', () => {
  const problems = topologyProblems([node(), peer({ wsUrl: 'ws://localhost:4175' })]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /same wsUrl/);
  assert.match(
    topologyProblems([node(), peer({ healthUrl: 'http://localhost:4176/health' })])[0],
    /same healthUrl/,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// The exit code says what actually happened
// ─────────────────────────────────────────────────────────────────────────────

test('a failure is a regression unless a listed defect says otherwise', () => {
  assert.deepEqual(classifyExit({ failedScenario: null }), {
    code: 0,
    outcome: 'passed',
    defect: null,
  });

  // The Redis scenario is where the suite used to hand out exit 2 for any failure at all, while
  // printing "these defects are open:" above an empty list.
  const redis = 'D: Redis loss and fail-closed lease expiry';
  assert.equal(
    classifyExit({ failedScenario: redis }).code,
    1,
    'with no defect listed, a failure there is a regression and must be reported as one',
  );
  assert.equal(
    classifyExit({ failedScenario: redis, knownOpenDefects: [] }).outcome,
    'failed',
  );

  const known = [{ scenario: redis, description: 'a defect somebody actually signed off on' }];
  const verdict = classifyExit({ failedScenario: redis, knownOpenDefects: known });
  assert.equal(verdict.code, 2);
  assert.equal(verdict.defect.description, known[0].description);
  assert.equal(
    classifyExit({ failedScenario: 'A: cross-node correctness', knownOpenDefects: known }).code,
    1,
    'a defect listed against one scenario cannot excuse a failure in another',
  );
});

test('the shipped defect list is empty, so no failure is currently excused', () => {
  assert.deepEqual(
    [...KNOWN_OPEN_DEFECTS],
    [],
    'an entry here silences a real failure; adding one is a decision, and this test is where it is ' +
      'recorded',
  );
});
