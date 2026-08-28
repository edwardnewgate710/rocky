#!/usr/bin/env node
/**
 * Runs the WebSocket baseline against the real two-gateway stack (M14 inc 47, ADR-0111).
 *
 * `scripts/load-test.mjs` measures the HTTP API and never opens a socket; this measures the path
 * `docs/SLO.md` records as unexercised — real sockets, real frames, and command forwarding between
 * two independent gateway processes over Redis.
 *
 * It brackets the k6 run with the two things k6 cannot see from inside a socket:
 *   - both gateway nodes report `commandRouting: redis` on /health, so this really is a two-node
 *     cluster rather than two isolated single-node gateways that would each pass on their own;
 *   - `gateway_forwarded_commands_total` grew by exactly the number of commands the isolated plan
 *     sends to the non-owning node. A handshake proves a URL answered; only that counter proves the
 *     cross-node path carried the moves (ADR-0010).
 *
 * There are no latency thresholds. `docs/SLO.md` has no end-to-end WebSocket objective, and one
 * run on one workstation is not the evidence needed to write one.
 *
 * Usage:
 *   docker compose -f docker-compose.yml -f docker-compose.chaos.yml up -d --build
 *   npm run load-test:ws
 *
 * Env — container-side URLs go INTO k6, runner-side URLs are used by this process:
 *   API_URL             API as seen from the k6 container (default http://host.docker.internal:8080)
 *   NODE1_WS_URL        node1 WebSocket, from the container  (default ws://host.docker.internal:4175)
 *   NODE2_WS_URL        node2 WebSocket, from the container  (default ws://host.docker.internal:4177)
 *   NODE1_HEALTH_URL, NODE2_HEALTH_URL     from this process (default http://localhost:417{6,8}/health)
 *   NODE1_METRICS_URL, NODE2_METRICS_URL   from this process (default http://localhost:417{6,8}/metrics)
 *   SPECTATORS_PER_NODE, MOVE_PLIES, MOVE_INTERVAL_MS   passed through to the scenario
 */

import { K6_IMAGE, fail, readSummaryMetrics, runK6 } from './lib/k6-docker.mjs';
import { readPrometheusCounter } from './lib/prometheus-text.mjs';
import {
  EVIDENCE_DIR,
  beginEvidence,
  buildEvidence,
  writeEvidence,
} from './lib/run-evidence.mjs';
import {
  DEFAULTS,
  expectedForwardedCommands,
  forwardingMismatch,
  wsBaselineK6Config,
} from '../deploy/load/scenarios/lib/ws-baseline-plan.mjs';

const EVIDENCE_FILE = 'ws-load-evidence.json';

const apiUrl = process.env['API_URL'] ?? 'http://host.docker.internal:8080';
const nodes = [
  {
    name: 'node1',
    wsUrl: process.env['NODE1_WS_URL'] ?? 'ws://host.docker.internal:4175',
    healthUrl: process.env['NODE1_HEALTH_URL'] ?? 'http://localhost:4176/health',
    metricsUrl: process.env['NODE1_METRICS_URL'] ?? 'http://localhost:4176/metrics',
  },
  {
    name: 'node2',
    wsUrl: process.env['NODE2_WS_URL'] ?? 'ws://host.docker.internal:4177',
    healthUrl: process.env['NODE2_HEALTH_URL'] ?? 'http://localhost:4178/health',
    metricsUrl: process.env['NODE2_METRICS_URL'] ?? 'http://localhost:4178/metrics',
  },
];

const plies = Number(process.env['MOVE_PLIES'] || DEFAULTS.plies);

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.text();
}

/**
 * A socket dropped underneath us is not the service failing.
 *
 * These reads bracket a k6 container run of several seconds, and the connection from the first
 * read sits idle across it — pooled by Node's fetch, and on this stack also carried by Docker's
 * port forwarder. Either can drop an idle socket, which surfaces as ECONNRESET on the second read
 * of a gateway that is answering perfectly well. Retried once; anything else propagates.
 */
function isDroppedIdleSocket(err) {
  const code = err?.cause?.code ?? err?.code;
  return code === 'ECONNRESET' || code === 'UND_ERR_SOCKET';
}

async function get(url) {
  try {
    return await fetchText(url);
  } catch (err) {
    if (!isDroppedIdleSocket(err)) throw err;
    return fetchText(url);
  }
}

/**
 * A node is usable only if it is routing commands through Redis.
 *
 * Without that, both gateways still answer /health and still serve sockets — they just each own
 * every game they are asked about, nothing is ever forwarded, and the run measures two unrelated
 * single-node deployments while looking exactly like a cluster.
 */
async function assertRoutingThroughRedis(node) {
  process.stdout.write(`Checking ${node.healthUrl} ... `);
  let health;
  try {
    health = JSON.parse(await get(node.healthUrl));
  } catch (err) {
    fail(
      `cannot reach ${node.name} (${err instanceof Error ? err.message : String(err)}).\n` +
        '  Start the two-gateway stack with:\n' +
        '    docker compose -f docker-compose.yml -f docker-compose.chaos.yml up -d --build',
    );
  }
  if (health.commandRouting !== 'redis') {
    fail(
      `${node.name} reports commandRouting="${health.commandRouting}", not "redis". ` +
        'Nothing would be forwarded, so this run could not measure the cross-node path.',
    );
  }
  console.log(`ok (${health.commandRouting} routing, ${health.ownedGames} owned games)`);
  return health;
}

const FORWARDED_METRIC = 'gateway_forwarded_commands_total';

async function readForwardedCommands(node) {
  let exposition = '';
  try {
    exposition = await get(node.metricsUrl);
  } catch (err) {
    fail(
      `cannot read ${node.metricsUrl} (${err instanceof Error ? err.message : String(err)}). ` +
        'Without both counters there is no proof the moves crossed between nodes.',
    );
  }
  const value = readPrometheusCounter(exposition, FORWARDED_METRIC);
  if (value === null || !Number.isFinite(value)) {
    fail(`${node.name} does not expose ${FORWARDED_METRIC} — the gateway metric surface changed.`);
  }
  return value;
}

function runWsBaseline() {
  return runK6(
    wsBaselineK6Config({
      apiUrl,
      node1WsUrl: nodes[0].wsUrl,
      node2WsUrl: nodes[1].wsUrl,
      environment: process.env,
    }),
  );
}

function reportLatency(metrics) {
  const ms = (trend, stat) =>
    typeof trend?.[stat] === 'number' ? `${trend[stat].toFixed(1)} ms` : 'n/a';
  const rows = [
    ['socket open (TCP + upgrade)', metrics.ws_connect_duration],
    ['join → joined', metrics.ws_join_duration],
    ["move → mover's own socket", metrics.ws_move_ack_duration],
    ['move → same node as mover', metrics.ws_move_same_node_duration],
    ['move → other gateway node', metrics.ws_move_other_node_duration],
  ];

  console.log('\n=== Network-visible latency — INFORMATIONAL, not an SLO ===\n');
  console.log('  measurement                    med        p95        max');
  for (const [label, trend] of rows) {
    console.log(
      `  ${label.padEnd(30)} ${ms(trend, 'med').padStart(9)}  ${ms(trend, 'p(95)').padStart(9)}` +
        `  ${ms(trend, 'max').padStart(9)}`,
    );
  }
  console.log('');
  console.log('  All sockets are driven by one k6 VU on one event loop, so these include client-side');
  console.log('  queueing and are an upper bound. docs/SLO.md still has no WebSocket objective.');
}

function reportCoverage(metrics) {
  const count = (metric) => (typeof metric?.count === 'number' ? metric.count : 'n/a');
  console.log('\n=== Coverage — these ARE enforced as k6 thresholds ===\n');
  console.log(`  sockets joined:           ${count(metrics.ws_joins_observed)}`);
  console.log(`  broadcasts delivered:     ${count(metrics.ws_broadcasts_observed)}`);
  console.log(`  protocol errors:          ${count(metrics.ws_protocol_errors)}`);
}

function forwardedDelta(before, after) {
  return nodes.reduce((sum, _node, index) => sum + (after[index] - before[index]), 0);
}

function reportForwarding(before, after) {
  console.log('\n=== Cross-node forwarding (ADR-0010) ===\n');
  for (const [index, node] of nodes.entries()) {
    console.log(`  ${node.name} ${FORWARDED_METRIC}: ${before[index]} → ${after[index]}`);
  }
  console.log(
    `  forwarded during this run: ${forwardedDelta(before, after)}` +
      `   (plan sends ${expectedForwardedCommands(plies)} to the non-owner)`,
  );
}

/** Counts and trend summaries worth carrying in the artifact beside the thresholds they answer. */
function observedFrom(metrics, forwarded) {
  const count = (metric) => (typeof metric?.count === 'number' ? metric.count : null);
  const trend = (metric) =>
    metric === undefined
      ? null
      : { med: metric.med ?? null, p95: metric['p(95)'] ?? null, max: metric.max ?? null };
  return {
    joinsObserved: count(metrics.ws_joins_observed),
    broadcastsObserved: count(metrics.ws_broadcasts_observed),
    protocolErrors: count(metrics.ws_protocol_errors),
    forwardedCommands: forwarded,
    latencyMs: {
      connect: trend(metrics.ws_connect_duration),
      join: trend(metrics.ws_join_duration),
      moveAck: trend(metrics.ws_move_ack_duration),
      moveSameNode: trend(metrics.ws_move_same_node_duration),
      moveOtherNode: trend(metrics.ws_move_other_node_duration),
    },
  };
}

/**
 * The k6 summary says what was measured; this says what it was measured against.
 *
 * `results/ws-summary.json` is deliberately metrics-only, because k6's built-in export would carry
 * the run's access tokens. That keeps it safe and leaves it unreadable on its own: no scenario, no
 * timestamp, no topology, no thresholds, no verdict. The envelope supplies those, and refuses to
 * be written if anything in it looks like a credential.
 */
async function main() {
  const startedAt = new Date();
  const configuration = {
    spectatorsPerNode: Number(process.env['SPECTATORS_PER_NODE'] || DEFAULTS.spectatorsPerNode),
    plies,
    moveIntervalMs: Number(process.env['MOVE_INTERVAL_MS'] || DEFAULTS.moveIntervalMs),
    k6Image: K6_IMAGE,
  };

  // Armed before the first thing that can exit. A node that is not routing through Redis, an
  // unreadable metric surface, or a summary that will not parse all end the process without
  // reaching the write below — and the previous run's artifact has already been cleared by then.
  const fallback = beginEvidence(EVIDENCE_DIR, EVIDENCE_FILE, (exitCode) =>
    buildEvidence({
      harness: 'ws-load',
      outcome: 'aborted',
      exitCode,
      startedAt,
      finishedAt: new Date(),
      topology: {
        apiUrl,
        nodes: nodes.map((node) => ({
          name: node.name,
          wsUrl: node.wsUrl,
          healthUrl: node.healthUrl,
        })),
      },
      configuration,
      observed: {},
      notes: ['The run ended before it produced a summary, so nothing was measured.'],
    }),
  );

  const routing = [];
  for (const node of nodes) routing.push(await assertRoutingThroughRedis(node));

  const before = await Promise.all(nodes.map(readForwardedCommands));
  const { code, summaryPath } = runWsBaseline();
  const after = await Promise.all(nodes.map(readForwardedCommands));

  const metrics = readSummaryMetrics(summaryPath);
  reportCoverage(metrics);
  reportLatency(metrics);

  const delta = forwardedDelta(before, after);
  const forwarded = {
    expected: expectedForwardedCommands(plies),
    observed: delta,
    perNode: nodes.map((node, index) => ({
      name: node.name,
      before: before[index],
      after: after[index],
    })),
  };

  const finish = (outcome, exitCode, note) => {
    const path = writeEvidence(
      EVIDENCE_DIR,
      EVIDENCE_FILE,
      buildEvidence({
        harness: 'ws-load',
        outcome,
        exitCode,
        startedAt,
        finishedAt: new Date(),
        topology: {
          apiUrl,
          summaryFile: summaryPath,
          nodes: nodes.map((node, index) => ({
            name: node.name,
            wsUrl: node.wsUrl,
            healthUrl: node.healthUrl,
            commandRouting: routing[index]?.commandRouting ?? null,
          })),
        },
        configuration,
        expected: {
          joins: 'ws_joins_observed count == planned sockets',
          broadcasts: 'ws_broadcasts_observed count == sockets x plies',
          protocolErrors: 'ws_protocol_errors count == 0',
          forwardedCommands: forwarded.expected,
          latency: 'no thresholds — docs/SLO.md has no WebSocket objective',
        },
        observed: observedFrom(metrics, forwarded),
        notes: [
          'Latency figures are informational and an upper bound: one k6 VU drives every socket on ' +
            'one event loop. They are not an SLO and support no claim about capacity.',
          ...(note ? [note] : []),
        ],
      }),
    );
    fallback.markWritten();
    console.log(`Evidence written to ${path}`);
  };

  if (code !== 0) {
    console.log('\n=== Result: THE RUN FAILED ===');
    console.log('A threshold here is coverage or correctness, not performance: a socket that never');
    console.log('joined, a ply a room never saw, or a frame the gateway should not have sent.');
    finish('threshold-breached', 1);
    process.exit(1);
  }

  reportForwarding(before, after);
  const mismatch = forwardingMismatch(delta, plies);
  if (mismatch) {
    // Evidence first: `fail` exits, and a run that proved the wrong thing is exactly the one whose
    // artifact somebody will want afterwards.
    finish('forwarding-mismatch', 1, mismatch);
    fail(
      `${mismatch}. The isolated plan alternates ${plies} plies across two nodes. A different ` +
        'count means the run did not exercise the path it claims to, or unrelated traffic shared the stack.',
    );
  }

  console.log('\n=== Result: every socket saw every ply, and the cluster path carried them ===');
  console.log(`Summary written to ${summaryPath}`);
  finish('passed', 0);
}

await main();
