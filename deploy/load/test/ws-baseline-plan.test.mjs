/**
 * Contract tests for the WebSocket baseline harness (M14 inc 47, ADR-0111).
 *
 * The k6 scenario itself cannot be executed here — it imports `k6/*`, which only the k6 runtime
 * provides — so the guards that decide whether a run is real live in `ws-baseline-plan.mjs` and are
 * exercised directly. Each test below stands for a way a run could report success while measuring
 * nothing: both players on one node (no forwarding), a game that was already played, a room shown
 * two different positions for the same ply, a socket count the gateway would silently truncate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULTS,
  ACCEPT_SEEK_METRIC_NAME,
  GATEWAY_LIMITS,
  K6_SYSTEM_TAGS,
  MOVE_PLAN,
  PLAYER_NODES,
  WS_SUMMARY_CONTAINER_PATH,
  classifyServerFrame,
  closeRoomLifetime,
  expectedForwardedCommands,
  forwardingMismatch,
  metricsOnlySummary,
  planBaseline,
  recordPosition,
  wsBaselineK6Config,
} from '../scenarios/lib/ws-baseline-plan.mjs';
import {
  RESULTS_DIR,
  buildK6Args,
  readPrometheusCounter,
} from '../../../scripts/lib/k6-docker.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (relative) => readFileSync(join(REPO_ROOT, relative), 'utf8');
const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const expectation = (overrides) => ({
  gameId: 'game-under-test',
  role: 'spectator',
  joined: false,
  nextPly: 1,
  nextUci: 'a2a3',
  nextBy: 'w',
  ...overrides,
});

const stateFixture = (overrides = {}) => ({
  gameId: 'game-under-test',
  variant: 'standard',
  players: { white: 'white-player', black: 'black-player' },
  timeControl: { kind: 'increment', initialMs: 600_000, incrementMs: 5_000, delayMs: 0 },
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  fenHash: 'position-0',
  ply: 0,
  turn: 'w',
  clock: { w: 600_000, b: 600_000 },
  turnStartedAt: null,
  status: { over: false },
  drawOffer: null,
  moves: [],
  legalMoves: { a2: ['a3', 'a4'] },
  ...overrides,
});

const joinedFrame = (overrides = {}) => ({
  t: 'joined',
  gameId: 'game-under-test',
  role: 'spectator',
  state: stateFixture(),
  ...overrides,
});

const moveFrame = (overrides = {}) => ({
  t: 'move',
  gameId: 'game-under-test',
  ply: 1,
  uci: 'a2a3',
  san: 'a3',
  by: 'w',
  fenHash: 'position-1',
  clock: { w: 599_900, b: 600_000 },
  serverTs: 1_000,
  legalMoves: { a7: ['a6', 'a5'] },
  ...overrides,
});

// ─── The move plan ───────────────────────────────────────────────────────────

test('planned line alternates colours, so consecutive commands reach different gateway nodes', () => {
  const colours = MOVE_PLAN.map((move) => move.by);
  assert.equal(colours[0], 'white');
  for (let ply = 1; ply < colours.length; ply += 1) {
    assert.notEqual(
      colours[ply],
      colours[ply - 1],
      `plies ${ply} and ${ply + 1} are both ${colours[ply]}: the second would be served by the ` +
        'node that already owns the game, and no command would ever be forwarded',
    );
  }
});

test('every planned move is a one-square pawn advance, which no later move can undo', () => {
  for (const { uci, by } of MOVE_PLAN) {
    const [fromFile, fromRank, toFile, toRank] = [uci[0], Number(uci[1]), uci[2], Number(uci[3])];
    assert.equal(fromFile, toFile, `${uci} changes file, so it is a capture and not a pawn push`);
    assert.equal(
      toRank - fromRank,
      by === 'white' ? 1 : -1,
      `${uci} is not a single forward step for ${by}`,
    );
    assert.ok(fromRank >= 2 && fromRank <= 7, `${uci} starts off a rank a pawn can occupy`);
  }
});

test('planned line never repeats a move, so no position can occur three times', () => {
  assert.equal(new Set(MOVE_PLAN.map((move) => move.uci)).size, MOVE_PLAN.length);
});

test('players are seated on different gateway nodes', () => {
  assert.notEqual(PLAYER_NODES.white, PLAYER_NODES.black);
});

test('half the plies are expected to be forwarded, whichever node claimed the game', () => {
  assert.equal(expectedForwardedCommands(32), 16);
  assert.equal(expectedForwardedCommands(9), 4);
  assert.equal(forwardingMismatch(16, 32), null);
  assert.match(forwardingMismatch(0, 32), /0 command.*exactly 16/);
  assert.match(forwardingMismatch(17, 32), /17 command.*exactly 16/);
});

test('a run too short to send a command through the non-owner is refused', () => {
  assert.throws(
    () => planBaseline({ spectatorsPerNode: 1, plies: 1, moveIntervalMs: 250 }),
    /at least 2/,
  );
});

// ─── The configuration guard ─────────────────────────────────────────────────

test('default configuration keeps every node under the gateway per-IP connection limit', () => {
  const { sockets } = planBaseline({
    spectatorsPerNode: DEFAULTS.spectatorsPerNode,
    plies: DEFAULTS.plies,
    moveIntervalMs: DEFAULTS.moveIntervalMs,
  });
  for (const node of new Set(sockets.map((socket) => socket.node))) {
    const onNode = sockets.filter((socket) => socket.node === node).length;
    assert.ok(
      onNode <= GATEWAY_LIMITS.maxConnectionsPerIp,
      `${onNode} sockets planned for ${node}, over the ${GATEWAY_LIMITS.maxConnectionsPerIp} limit`,
    );
  }
});

test('mirrored gateway limits match the production gateway defaults', () => {
  const gateway = read('services/gateway/src/serve.ts');
  const defaults = {
    WS_MAX_CONNECTIONS_PER_IP: GATEWAY_LIMITS.maxConnectionsPerIp,
    WS_MAX_MESSAGES_PER_WINDOW: GATEWAY_LIMITS.maxMessagesPerWindow,
    WS_MESSAGE_WINDOW_MS: GATEWAY_LIMITS.messageWindowMs,
  };
  for (const [name, value] of Object.entries(defaults)) {
    assert.match(
      gateway,
      new RegExp(`positiveIntEnv\\('${name}',\\s*${value.toLocaleString('en-US').replace(',', '_')}\\)`),
      `${name} changed in the gateway; update and re-validate the k6 plan instead of drifting`,
    );
  }
});

test('spectator gallery that would exceed the per-IP connection limit is refused', () => {
  assert.throws(
    () =>
      planBaseline({
        spectatorsPerNode: GATEWAY_LIMITS.maxConnectionsPerIp,
        plies: 4,
        moveIntervalMs: 250,
      }),
    /WS_MAX_CONNECTIONS_PER_IP/,
  );
});

test('finite move plan stays below the frame limit even at fast pacing', () => {
  assert.doesNotThrow(() =>
    planBaseline({ spectatorsPerNode: 1, plies: MOVE_PLAN.length, moveIntervalMs: 1 }),
  );
});

test('asking for more plies than the planned line has is refused', () => {
  assert.throws(
    () => planBaseline({ spectatorsPerNode: 1, plies: MOVE_PLAN.length + 1, moveIntervalMs: 250 }),
    /MOVE_PLIES/,
  );
});

// ─── Frame verification ──────────────────────────────────────────────────────

test('the planned move broadcast is accepted', () => {
  assert.deepEqual(classifyServerFrame(moveFrame(), expectation()), { kind: 'move' });
});

test('a broadcast for a different game is refused', () => {
  const frame = moveFrame({ gameId: 'some-other-game' });
  const outcome = classifyServerFrame(frame, expectation());
  assert.equal(outcome.kind, 'unexpected');
  assert.match(outcome.reason, /different game/);
});

test('a broadcast for a ply the socket has already seen is refused', () => {
  const frame = moveFrame({ ply: 3, uci: 'b2b3', by: 'w' });
  const outcome = classifyServerFrame(frame, expectation({ nextPly: 4, nextUci: 'b7b6' }));
  assert.equal(outcome.kind, 'unexpected');
  assert.match(outcome.reason, /ply 3, expected ply 4/);
});

test('a broadcast carrying a move the plan never sent is refused', () => {
  const frame = moveFrame({ uci: 'e2e4' });
  const outcome = classifyServerFrame(frame, expectation());
  assert.equal(outcome.kind, 'unexpected');
  assert.match(outcome.reason, /"e2e4", expected "a2a3"/);
});

test('joining a game that has already been played is refused', () => {
  const frame = joinedFrame({ state: stateFixture({ ply: 7 }) });
  const outcome = classifyServerFrame(frame, expectation());
  assert.equal(outcome.kind, 'unexpected');
  assert.match(outcome.reason, /joined a game at ply 7/);
});

test('being seated in a role the plan did not ask for is refused', () => {
  const frame = joinedFrame();
  const outcome = classifyServerFrame(frame, expectation({ role: 'white' }));
  assert.equal(outcome.kind, 'unexpected');
  assert.match(outcome.reason, /joined as "spectator", expected "white"/);
});

test('a fresh join at the start of the planned line is accepted', () => {
  const frame = joinedFrame({ role: 'white' });
  assert.deepEqual(classifyServerFrame(frame, expectation({ role: 'white' })), { kind: 'joined' });
});

test('a duplicate joined acknowledgement is refused', () => {
  const outcome = classifyServerFrame(joinedFrame(), expectation({ joined: true }));
  assert.equal(outcome.kind, 'unexpected');
  assert.match(outcome.reason, /duplicate joined/);
});

test('joined state for a different game is refused', () => {
  const frame = joinedFrame({ state: stateFixture({ gameId: 'some-other-game' }) });
  const outcome = classifyServerFrame(frame, expectation());
  assert.equal(outcome.kind, 'unexpected');
  assert.match(outcome.reason, /joined state carries a different game/);
});

test('a joined acknowledgement with a partial state is refused', () => {
  const outcome = classifyServerFrame(
    joinedFrame({ state: { gameId: 'game-under-test', ply: 0 } }),
    expectation(),
  );
  assert.equal(outcome.kind, 'unexpected');
  assert.match(outcome.reason, /malformed authoritative state/);
});

test('a joined acknowledgement missing a required authoritative field is refused', () => {
  for (const field of [
    'variant',
    'players',
    'timeControl',
    'fen',
    'fenHash',
    'turn',
    'clock',
    'turnStartedAt',
    'status',
    'drawOffer',
    'moves',
    'legalMoves',
  ]) {
    const state = stateFixture();
    delete state[field];
    const outcome = classifyServerFrame(joinedFrame({ state }), expectation());
    assert.equal(outcome.kind, 'unexpected', field);
    assert.match(outcome.reason, /malformed authoritative state/, field);
  }
});

test('a joined acknowledgement with an incomplete time control is refused', () => {
  for (const field of ['initialMs', 'incrementMs', 'delayMs']) {
    const timeControl = { ...stateFixture().timeControl };
    delete timeControl[field];
    const outcome = classifyServerFrame(
      joinedFrame({ state: stateFixture({ timeControl }) }),
      expectation(),
    );
    assert.equal(outcome.kind, 'unexpected', field);
    assert.match(outcome.reason, /malformed authoritative state/, field);
  }
  const timeControl = { ...stateFixture().timeControl, kind: 'fast' };
  const wrongKind = classifyServerFrame(
    joinedFrame({ state: stateFixture({ timeControl }) }),
    expectation(),
  );
  assert.equal(wrongKind.kind, 'unexpected');
});

test('a move attributed to the wrong player is refused', () => {
  const outcome = classifyServerFrame(moveFrame({ by: 'b' }), expectation());
  assert.equal(outcome.kind, 'unexpected');
  assert.match(outcome.reason, /broadcast by "b", expected "w"/);
});

test('a move without a position hash is refused', () => {
  const outcome = classifyServerFrame(moveFrame({ fenHash: undefined }), expectation());
  assert.equal(outcome.kind, 'unexpected');
  assert.match(outcome.reason, /no position hash/);
});

test('a move missing another authoritative field is refused', () => {
  const outcome = classifyServerFrame(moveFrame({ clock: undefined }), expectation());
  assert.equal(outcome.kind, 'unexpected');
  assert.match(outcome.reason, /malformed authoritative move/);
});

test('a rejected command fails the run rather than being skipped', () => {
  const frame = { t: 'reject', gameId: 'game-under-test', code: 'not_your_turn', ref: 1 };
  const outcome = classifyServerFrame(frame, expectation());
  assert.equal(outcome.kind, 'unexpected');
  assert.match(outcome.reason, /not_your_turn/);
});

test('presence chatter is accepted and everything else is refused', () => {
  const gameId = 'game-under-test';
  assert.equal(
    classifyServerFrame({ t: 'presence', gameId, white: true, black: true, spectators: 0 }, expectation()).kind,
    'presence',
  );
  for (const t of ['ended', 'state', 'resumed', 'pong', 'nonsense']) {
    assert.equal(classifyServerFrame({ t, gameId }, expectation()).kind, 'unexpected', t);
  }
  assert.equal(classifyServerFrame('not-an-object', expectation()).kind, 'unexpected');
});

test('malformed presence chatter is refused', () => {
  const outcome = classifyServerFrame(
    { t: 'presence', gameId: 'game-under-test', white: true, black: false, spectators: -1 },
    expectation(),
  );
  assert.equal(outcome.kind, 'unexpected');
  assert.match(outcome.reason, /presence frame is malformed/);
});

// ─── Position agreement across the room ──────────────────────────────────────

test('two nodes broadcasting different positions for one ply is reported', () => {
  const ledger = new Map();
  assert.equal(recordPosition(ledger, 1, 'hash-a'), null);
  assert.equal(recordPosition(ledger, 1, 'hash-a'), null, 'the same position must agree with itself');
  assert.equal(recordPosition(ledger, 2, 'hash-b'), null, 'a later ply is a separate position');
  assert.match(recordPosition(ledger, 1, 'hash-c'), /two different positions/);
});

test('a broadcast with no position hash is reported', () => {
  assert.match(recordPosition(new Map(), 1, undefined), /no position hash/);
});

// ─── Harness contracts outside the frame classifier ─────────────────────────

test('k6 summaries land where git is told to ignore them', () => {
  assert.ok(
    read('.gitignore')
      .split('\n')
      .some((line) => line.trim() === `${RESULTS_DIR}/`),
    `${RESULTS_DIR}/ is where both load runners write their summaries and must stay gitignored`,
  );
});

test('k6 built-in metric tags exclude raw URLs and name the generated seek route', () => {
  assert.equal(K6_SYSTEM_TAGS.includes('url'), false);
  assert.equal(K6_SYSTEM_TAGS.includes('name'), true);
  assert.equal(ACCEPT_SEEK_METRIC_NAME, 'POST /v1/seeks/:id/accept');
  assert.equal(/[0-9a-f]{8}-[0-9a-f-]{27}/i.test(ACCEPT_SEEK_METRIC_NAME), false);
});

test('Prometheus counter parser matches the exact metric and reports absence', () => {
  const exposition = [
    '# HELP gateway_forwarded_commands_total Forwarded commands',
    'gateway_forward_latency_seconds_bucket{le="0.1"} 99',
    'gateway_forwarded_commands_total 16',
    'gateway_forwarded_commands_total_extra 200',
  ].join('\n');
  assert.equal(readPrometheusCounter(exposition, 'gateway_forwarded_commands_total'), 16);
  assert.equal(readPrometheusCounter(exposition, 'gateway_missing_total'), null);
});

test('WebSocket summary serialization excludes setup data and access tokens', () => {
  const whiteToken = 'live-white-token-that-must-not-reach-disk';
  const blackToken = 'live-black-token-that-must-not-reach-disk';
  const serialized = metricsOnlySummary({
    metrics: { ws_joins_observed: { values: { count: 34 }, type: 'counter' } },
    setup_data: { gameId: 'secret-game', tokens: { white: whiteToken, black: blackToken } },
    root_group: { name: 'root' },
  });
  const parsed = JSON.parse(serialized);

  assert.deepEqual(Object.keys(parsed), ['metrics']);
  assert.equal(parsed.metrics.ws_joins_observed.count, 34);
  assert.doesNotMatch(serialized, new RegExp(`${whiteToken}|${blackToken}|secret-game`));
  assert.equal(WS_SUMMARY_CONTAINER_PATH, '/load/results/ws-summary.json');
});

test('WebSocket scenario keeps the credential-safe summary wiring and emits no console output', () => {
  const source = withoutComments(read('deploy/load/scenarios/ws-baseline.js'));
  const handleSummary = /export function handleSummary\(data\)\s*\{([\s\S]*?)\n\}/.exec(source);

  assert.doesNotMatch(source, /\bconsole\./);
  assert.ok(handleSummary, 'the scenario must keep an explicit handleSummary implementation');
  assert.match(handleSummary[1], /\bmetricsOnlySummary\s*\(\s*data\s*\)/);
  assert.doesNotMatch(handleSummary[1], /\bJSON\.stringify\s*\(\s*data\s*\)/);
});

test('WebSocket Docker invocation cannot enable k6 secret-bearing built-in summary export', () => {
  const config = wsBaselineK6Config({
    apiUrl: 'http://api.test',
    node1WsUrl: 'ws://node1.test',
    node2WsUrl: 'ws://node2.test',
    environment: { SPECTATORS_PER_NODE: '4', MOVE_PLIES: '8', MOVE_INTERVAL_MS: '50' },
  });
  const args = buildK6Args(config, 'C:/repo');

  assert.equal(config.summaryExport, false);
  assert.equal(args.includes('--summary-export'), false);
  assert.ok(args.includes('-e'));
  assert.ok(args.includes('MOVE_PLIES=8'));
  assert.equal(args.at(-1), '/load/scenarios/ws-baseline.js');
});

test('HTTP Docker invocation preserves the existing built-in summary export', () => {
  const args = buildK6Args(
    {
      scenario: 'deploy/load/scenarios/api-baseline.js',
      summaryFile: 'summary.json',
      env: { BASE_URL: 'http://api.test' },
    },
    'C:/repo',
  );
  const flag = args.indexOf('--summary-export');
  assert.ok(flag >= 0);
  assert.equal(args[flag + 1], '/load/results/summary.json');
  assert.equal(args.at(-1), '/load/scenarios/api-baseline.js');
});

test('room cleanup is terminal, idempotent, and failure-isolated', () => {
  const calls = [];
  const room = {
    closed: false,
    closing: false,
    ply: { abort: (reason) => calls.push(`abort:${reason}`) },
    sockets: [
      {
        cancelJoin: (reason) => calls.push(`cancel:first:${reason}`),
        ws: { close: () => { throw new Error('already failed'); } },
      },
      {
        cancelJoin: () => { throw new Error('already settled'); },
        ws: { close: () => calls.push('close:second') },
      },
    ],
  };

  assert.equal(closeRoomLifetime(room, 'stop'), true);
  assert.equal(closeRoomLifetime(room, 'again'), false);
  assert.equal(room.closed, true);
  assert.equal(room.closing, true);
  assert.deepEqual(calls, ['abort:stop', 'cancel:first:stop', 'close:second']);
});
