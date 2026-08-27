/**
 * Timing, topology and verdict logic for the chaos suite (ADR-0077).
 *
 * `scripts/chaos-test.mjs` cannot be imported by `node --test`: importing it starts a run against a
 * live two-node stack. So the decisions that determine whether a run proved anything live here, as
 * dependency-free pure functions, and `deploy/load/test/chaos-plan.test.mjs` exercises them
 * directly — the same split `deploy/load/scenarios/lib/ws-baseline-plan.mjs` uses for the k6
 * scenario, and for the same reason.
 *
 * Everything in this file exists because the chaos suite's job is to make an induced failure
 * observable. A number guessed here rather than derived, or a verdict that accepts any error as
 * proof of the specific error under test, turns that job into theatre.
 */

/**
 * The gateway's own forwarding budget, mirrored from `DEFAULT_FORWARD_TIMEOUT_MS` in
 * `services/gateway/src/command-forwarder.ts`.
 *
 * Mirrored rather than imported because the gateway is TypeScript that must be built first, and
 * this module has to stay importable by a bare `node --test`. The mirror is load-bearing, not
 * decorative: a client that gives up before this elapses can never distinguish "the gateway
 * refused" from "the gateway has not answered yet", and the chaos suite's Redis-outage assertions
 * are exactly assertions about a refusal.
 */
export const FORWARD_TIMEOUT_MS = 5000;

/** Slack added to a derived deadline so a busy CI runner does not read as a behaviour change. */
const FAILOVER_BUFFER_MS = 1000;

/**
 * The wider slack the fast-path expiry wait has always carried.
 *
 * Kept separate so every deadline below reproduces, exactly, the number this suite used at the
 * stack's default 6s/2s lease: 7000, 5000 and 5100. Deriving them is meant to stop them drifting
 * from the lease, not to quietly retune a suite nobody has re-run since.
 */
const LEASE_WAIT_BUFFER_MS = 1500;

/** Extra room past the gateway's own budget before a silence is recorded as a silence. */
const INDUCED_FAILURE_MARGIN_MS = 2000;

function assertPositiveNumber(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got ${String(value)}`);
  }
}

/**
 * Every deadline the chaos scenarios wait on, derived from the two lease numbers the stack runs
 * with rather than written down again.
 *
 * The suite already derived its fast-path window this way, because an earlier version slept a flat
 * 3s against a ~3.6s window and could only pass by luck. The other waits were still literals: a
 * `7000` beside the comment "Lease TTL is 6s", and a `5000` graceful-drain budget. Raise
 * `OWNERSHIP_LEASE_TTL_SEC` in `docker-compose.chaos.yml` and the first becomes too short to prove
 * failover happened, while the second stops proving the drain beat the TTL at all — silently, in
 * both directions.
 *
 * `safetyMarginMs` reproduces `OwnershipRegistry.safetyMarginMs` (ADR-0078); the window in which a
 * node will still serve from its lease without reaching Redis is what is left of the TTL after it.
 */
export function leaseTiming({ leaseTtlSec, renewalIntervalSec }) {
  assertPositiveNumber('OWNERSHIP_LEASE_TTL_SEC', leaseTtlSec);
  assertPositiveNumber('OWNERSHIP_RENEWAL_INTERVAL_SEC', renewalIntervalSec);
  if (renewalIntervalSec >= leaseTtlSec) {
    throw new Error(
      `OWNERSHIP_RENEWAL_INTERVAL_SEC=${renewalIntervalSec} must be below ` +
        `OWNERSHIP_LEASE_TTL_SEC=${leaseTtlSec}; a lease that cannot be renewed inside its own ` +
        'term has no fast-path window for the Redis-outage scenario to measure.',
    );
  }

  const leaseTtlMs = leaseTtlSec * 1000;
  const safetyMarginMs =
    Math.floor(((leaseTtlSec - renewalIntervalSec) * 1000) / 2) +
    Math.min(1000, Math.max(200, Math.floor(renewalIntervalSec * 200)));
  const fastPathWindowMs = leaseTtlMs - safetyMarginMs;
  if (fastPathWindowMs <= 0) {
    throw new Error(
      `a lease of ${leaseTtlSec}s renewed every ${renewalIntervalSec}s leaves no fast-path ` +
        'window, so an owner could never serve a command during a Redis outage.',
    );
  }

  /**
   * The graceful-drain budget has to be strictly under the TTL, or beating it proves nothing: the
   * ungraceful path already gets there by waiting for expiry. One second under is the number this
   * suite has always used at the default 6s TTL, now tied to the TTL instead of restating it.
   */
  const gracefulFailoverBudgetMs = leaseTtlMs - FAILOVER_BUFFER_MS;
  if (gracefulFailoverBudgetMs <= 0) {
    throw new Error(
      `OWNERSHIP_LEASE_TTL_SEC=${leaseTtlSec} is too short for the graceful-drain scenario to ` +
        'distinguish a released lease from an expired one.',
    );
  }

  return Object.freeze({
    leaseTtlMs,
    safetyMarginMs,
    fastPathWindowMs,
    /** After a SIGKILL nothing releases the key, so the successor waits out the whole TTL. */
    ungracefulFailoverWaitMs: leaseTtlMs + FAILOVER_BUFFER_MS,
    /** A released lease must be claimed this much faster than one that merely expired. */
    gracefulFailoverBudgetMs,
    /** How long to watch a graceful failover, so a slow one reports its time instead of a timeout. */
    gracefulObservationWindowMs: leaseTtlMs + FAILOVER_BUFFER_MS,
    /** The fast path has aged out by here, so the owner must start failing closed. */
    fastPathExpiryWaitMs: fastPathWindowMs + LEASE_WAIT_BUFFER_MS,
  });
}

/**
 * How long to wait for a command issued into an induced outage before calling it unanswered.
 *
 * Strictly longer than the gateway's own forwarding budget, and that inequality is the whole point.
 * The suite used to wait 3000ms against the gateway's 5000ms, so every "the command failed as
 * expected" it reported was the *client* giving up first — and would have read exactly the same if
 * the gateway had been about to accept the move at 4000ms. A deadline shorter than the decision it
 * observes cannot witness that decision.
 */
export function inducedFailureBudgetMs(forwardTimeoutMs = FORWARD_TIMEOUT_MS) {
  assertPositiveNumber('forwardTimeoutMs', forwardTimeoutMs);
  return forwardTimeoutMs + INDUCED_FAILURE_MARGIN_MS;
}

/**
 * What a command issued into an induced outage actually did.
 *
 * Three outcomes, kept apart because they are not equally good evidence and the run should say
 * which one it got:
 *
 * - `accepted` — the gateway applied a command it should have refused. The scenario has failed.
 * - `rejected` — an explicit `reject` frame arrived. The strong result: the gateway reached a
 *   decision and told the client what it was.
 * - `silent` — the full budget elapsed with no answer. Legitimate, because with Redis gone there
 *   may be nothing left to answer with, but weaker — and it is also what a broken harness produces,
 *   so it is recorded as itself rather than laundered into "rejected as expected".
 */
export function classifyInducedOutcome({ accepted, rejectCode }) {
  if (accepted) return Object.freeze({ kind: 'accepted', code: null });
  if (typeof rejectCode === 'string' && rejectCode.length > 0) {
    return Object.freeze({ kind: 'rejected', code: rejectCode });
  }
  return Object.freeze({ kind: 'silent', code: null });
}

/** The reason an induced-outage command must fail the scenario, or `null` when it held. */
export function inducedFailureVerdict(outcome, what) {
  return outcome.kind === 'accepted'
    ? `${what} was ACCEPTED during the induced outage; the guard it is meant to hit never fired`
    : null;
}

/**
 * Which node claimed a game, read as growth against a baseline rather than as a raw count.
 *
 * `ownedGames` is a per-node count over every game that node owns, and ownership outlives the
 * scenario that created it — so by the third scenario both nodes legitimately report a non-zero
 * count and a raw reading says nothing about the game under test. Returns `null` while no single
 * node has grown, so the caller can keep polling: the claim races the command that triggers it.
 */
export function ownershipFromCounts(baseline, current) {
  const grew1 = current.n1 > baseline.n1;
  const grew2 = current.n2 > baseline.n2;
  if (grew1 && !grew2) return Object.freeze({ owner: 1, nonOwner: 2 });
  if (grew2 && !grew1) return Object.freeze({ owner: 2, nonOwner: 1 });
  return null;
}

/**
 * Why a node cannot be said to have taken this game over, or `null` when it can.
 *
 * The failover scenarios used to assert `ownedGames >= 1` on the survivor. That is satisfied by any
 * game the survivor already owned: once the SIGKILL scenario has handed node2 a game, the graceful
 * drain scenario's identical check passes before that scenario has done anything at all. A vacuous
 * assertion in a failover test is worse than no assertion, because the report says failover was
 * verified.
 */
export function ownershipTakeoverProblem(baseline, current, expectedNode) {
  const key = expectedNode === 1 ? 'n1' : 'n2';
  const otherKey = expectedNode === 1 ? 'n2' : 'n1';
  const otherNode = expectedNode === 1 ? 2 : 1;
  if (current[key] > baseline[key]) return null;
  return (
    `node${expectedNode} owns ${current[key]} game(s), no more than the ${baseline[key]} it ` +
    `owned before this scenario began, so nothing here shows it took this game over ` +
    `(node${otherNode}: ${baseline[otherKey]} → ${current[otherKey]}). A raw non-zero count ` +
    'would only prove an earlier scenario left a game behind.'
  );
}

/**
 * Why a node cannot be said to have kept its games, or `null` when it can.
 *
 * The mirror image of the check above, for the scenario that removes a node which owns nothing:
 * the owner's count must not move. Growth would mean it re-claimed a game it already held (a lease
 * it dropped), and a drop would mean it lost one it should have kept.
 */
export function ownershipHeldProblem(baseline, current, expectedNode) {
  const key = expectedNode === 1 ? 'n1' : 'n2';
  if (current[key] === baseline[key]) return null;
  return (
    `node${expectedNode} owned ${baseline[key]} game(s) before its peer was removed and ` +
    `${current[key]} after; removing a node that owns nothing must not move the owner's lease ` +
    'in either direction.'
  );
}

/**
 * Reasons the stack in front of the suite is not the stack it claims to test, or an empty list.
 *
 * Both gateways answering `/health` is not the precondition. Two gateways each routing commands
 * locally answer every health check, serve every socket, each own every game they are asked about,
 * and forward nothing — a cluster-shaped run measuring two unrelated single-node deployments.
 * `scripts/ws-load-test.mjs` refuses to start without this check; the chaos suite, which is the one
 * that actually kills things, did not have it.
 */
export function topologyProblems(nodes) {
  if (nodes.length !== 2) {
    return [`expected exactly 2 gateway nodes, got ${nodes.length}`];
  }
  const problems = [];
  for (const node of nodes) {
    if (node.health?.commandRouting !== 'redis') {
      problems.push(
        `${node.name} reports commandRouting="${String(node.health?.commandRouting)}", not ` +
          '"redis": nothing would ever be forwarded, so no scenario here could measure the ' +
          'cross-node path it names.',
      );
    }
  }
  for (const field of ['wsUrl', 'healthUrl', 'metricsUrl']) {
    if (nodes[0][field] === nodes[1][field]) {
      problems.push(
        `both nodes are configured with the same ${field} (${String(nodes[0][field])}): the run ` +
          'would kill and measure one process while reporting on two.',
      );
    }
  }
  return problems;
}

/**
 * Defects this suite is known to observe, each naming the scenario it shows up in.
 *
 * Empty means every failure is a regression. That is the honest default, and keeping the list empty
 * while still routing failures to the "known defect" exit code is exactly what this list exists to
 * prevent — see `classifyExit`.
 */
export const KNOWN_OPEN_DEFECTS = Object.freeze([]);

/**
 * The suite's exit code.
 *
 * The documented contract is 0 for a clean run, 1 for a regression, and 2 when only KNOWN OPEN
 * DEFECTS were observed. The implementation instead returned 2 for *any* failure once the Redis
 * scenario had been reached, and printed "these defects are open:" above an empty list — so a
 * genuine regression in the last and most destructive scenario was reported, in words and in the
 * exit code, as something somebody had already signed off on. A failure is a regression unless a
 * listed defect says otherwise.
 */
export function classifyExit({ failedScenario, knownOpenDefects = KNOWN_OPEN_DEFECTS }) {
  if (!failedScenario) return Object.freeze({ code: 0, outcome: 'passed', defect: null });
  const defect = knownOpenDefects.find((entry) => entry.scenario === failedScenario) ?? null;
  return defect
    ? Object.freeze({ code: 2, outcome: 'known-defect', defect })
    : Object.freeze({ code: 1, outcome: 'failed', defect: null });
}
