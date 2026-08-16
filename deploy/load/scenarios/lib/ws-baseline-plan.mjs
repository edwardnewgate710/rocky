/**
 * Planning and frame verification for the WebSocket baseline (M14 inc 47).
 *
 * Split out of `../ws-baseline.js` because a k6 script cannot be executed by `node --test`: it
 * imports `k6/*`, which only the k6 runtime provides. Everything here is dependency-free ESM, so
 * `deploy/load/test/ws-baseline-plan.test.mjs` exercises the correctness guards directly rather
 * than asserting them by reading the scenario as text — and `scripts/ws-load-test.mjs` reads the
 * same defaults the scenario runs with instead of restating them.
 */

/**
 * Connection and message limits the gateway enforces per connection and per source IP, mirrored
 * from the defaults in `services/gateway/src/serve.ts`.
 *
 * They are mirrored rather than imported because the gateway is a TypeScript service and this file
 * runs inside k6. That makes them a drift risk, which is exactly why they are stated once, here,
 * and checked: k6 generates all its load from one container, so the gateway sees every socket as a
 * single IP and the per-IP ceiling — not the hardware — is what bounds this baseline.
 *
 * Raising them is out of scope. This harness stays under the production limits so the numbers it
 * produces describe the service as it is configured to run.
 */
export const GATEWAY_LIMITS = Object.freeze({
  /** `WS_MAX_CONNECTIONS_PER_IP` — sockets one source IP may hold open on one gateway node. */
  maxConnectionsPerIp: 20,
  /** `WS_MAX_MESSAGES_PER_WINDOW` — client frames one connection may send per window. */
  maxMessagesPerWindow: 60,
  /** `WS_MESSAGE_WINDOW_MS` — the window the frame budget above is counted over. */
  messageWindowMs: 10_000,
});

/** The two gateway nodes `docker-compose.chaos.yml` runs, named as that file names them. */
export const NODES = Object.freeze(['node1', 'node2']);

/**
 * White plays through node1 and black through node2, so the movers alternate across nodes.
 *
 * This is the whole reason the baseline touches the multi-node path: ownership is claimed by the
 * first game command (`RedisCommandRouter.route`), so white's opening move pins the game to node1
 * and every black move after it has to be forwarded there over Redis. Seat both players on one
 * node and the run still passes while measuring nothing but a single node's fast path.
 */
export const PLAYER_NODES = Object.freeze({ white: 'node1', black: 'node2' });

/** Defaults for a run that fits a developer workstation and stays under `GATEWAY_LIMITS`. */
export const DEFAULTS = Object.freeze({
  spectatorsPerNode: 16,
  plies: 32,
  moveIntervalMs: 250,
});

/** k6's container path for the deliberately metrics-only WebSocket summary. */
export const WS_SUMMARY_FILE = 'ws-summary.json';
export const WS_SUMMARY_CONTAINER_PATH = `/load/results/${WS_SUMMARY_FILE}`;

/** Built-in k6 tags retained by this harness. Raw `url` is intentionally excluded. */
export const K6_SYSTEM_TAGS = Object.freeze([
  'proto',
  'status',
  'method',
  'name',
  'group',
  'check',
  'error',
  'error_code',
  'scenario',
  'expected_response',
]);

/** Bounded metric name for the only request whose URL contains a generated resource id. */
export const ACCEPT_SEEK_METRIC_NAME = 'POST /v1/seeks/:id/accept';

/** Build the one credential-safe k6 invocation contract shared by the runner and its tests. */
export function wsBaselineK6Config({ apiUrl, node1WsUrl, node2WsUrl, environment }) {
  return {
    scenario: 'deploy/load/scenarios/ws-baseline.js',
    summaryFile: WS_SUMMARY_FILE,
    // `handleSummary` writes metrics only. Built-in export would persist secret setup data.
    summaryExport: false,
    target: `${node1WsUrl} + ${node2WsUrl}`,
    env: {
      API_URL: apiUrl,
      NODE1_WS_URL: node1WsUrl,
      NODE2_WS_URL: node2WsUrl,
      SPECTATORS_PER_NODE: environment.SPECTATORS_PER_NODE || undefined,
      MOVE_PLIES: environment.MOVE_PLIES || undefined,
      MOVE_INTERVAL_MS: environment.MOVE_INTERVAL_MS || undefined,
    },
  };
}

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

/**
 * Two single-square advances of every pawn, file by file, colours strictly alternating:
 * a2a3 a7a6 b2b3 b7b6 … h2h3 h7h6, then a3a4 a6a5 … h3h4 h6h5.
 *
 * Chosen over a famous game's move list because both properties this needs are provable by
 * inspection rather than by having run it once:
 *
 * - **Every move is legal.** Only pawns move, always one square forward into a square that is
 *   empty at that point (white occupies rank 3 then 4, black rank 6 then 5, so the two never meet).
 *   Both back ranks are untouched, so no move exposes a king and neither king is ever attacked —
 *   a pawn on rank 4 attacks rank 5, and no king goes there.
 * - **The game cannot end early.** This engine ends a game on threefold repetition
 *   (`packages/game/src/game.ts`), and a pawn advance is irreversible: no position can occur twice,
 *   so no position can occur three times. There is no checkmate, stalemate or capture in the line.
 *
 * An opening line that ends in mate — or shuffles pieces back to a repeated position — would fail
 * the run for a reason that has nothing to do with the gateway.
 */
export const MOVE_PLAN = buildMovePlan();

function buildMovePlan() {
  const advances = [
    [2, 3, 7, 6],
    [3, 4, 6, 5],
  ];
  const moves = [];
  for (const [whiteFrom, whiteTo, blackFrom, blackTo] of advances) {
    for (const file of FILES) {
      moves.push(Object.freeze({ uci: `${file}${whiteFrom}${file}${whiteTo}`, by: 'white' }));
      moves.push(Object.freeze({ uci: `${file}${blackFrom}${file}${blackTo}`, by: 'black' }));
    }
  }
  return Object.freeze(moves);
}

/**
 * Commands the non-owning node has to forward for a run of `plies` moves.
 *
 * The first command claims ownership for the node it arrived on, so every command the *other*
 * player sends after that is forwarded. Both players make the same number of moves over an even
 * ply count and differ by one over an odd count, so the floor holds whichever node claimed first.
 * `scripts/ws-load-test.mjs` compares this against the real
 * `gateway_forwarded_commands_total` delta.
 */
export function expectedForwardedCommands(plies) {
  return Math.floor(plies / 2);
}

/** Exact isolated-stack forwarding contract, or the reason the run cannot claim that coverage. */
export function forwardingMismatch(actual, plies) {
  const expected = expectedForwardedCommands(plies);
  return actual === expected
    ? null
    : `${actual} command(s) were forwarded; exactly ${expected} must cross`;
}

/**
 * End a room lifetime exactly once and isolate cleanup failures between owned resources.
 *
 * Kept in this dependency-free module so the failure-path contract can run under `node --test`;
 * the k6 scenario supplies the real barrier, join cancellers, and WebSockets.
 */
export function closeRoomLifetime(room, reason) {
  if (room.closed) return false;
  room.closed = true;
  room.closing = true;

  try {
    room.ply?.abort(reason);
  } catch {
    // One broken cleanup callback must not leave the remaining sockets and timers alive.
  }
  for (const socket of room.sockets) {
    try {
      socket.cancelJoin(reason);
    } catch {
      // Continue closing every resource owned by the room.
    }
    try {
      socket.ws.close();
    } catch {
      // A socket may already have failed during connection setup; the room is still terminal.
    }
  }
  return true;
}

function assertPositiveInteger(name, value, max) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${String(value)}`);
  }
  if (max !== undefined && value > max) {
    throw new Error(`${name} must be at most ${max}, got ${value}`);
  }
}

/**
 * Frames one player sends inside a single rate-limit window at this pacing.
 *
 * The players alternate, so each of them moves once per two intervals. The `+ 1` terms are the
 * partial move that can land at the window edge and the `join` frame, which shares the first
 * window with the opening moves.
 */
function peakClientFramesPerWindow(plies, moveIntervalMs) {
  const { messageWindowMs } = GATEWAY_LIMITS;
  const totalFramesInRun = 1 + Math.ceil(plies / 2); // join + the busier (White) player
  const framesThatFitInOneWindow = Math.floor(messageWindowMs / (moveIntervalMs * 2)) + 2;
  return Math.min(totalFramesInRun, framesThatFitInOneWindow);
}

/**
 * Validate a configuration and expand it into the sockets to open and the moves to play.
 *
 * Throws rather than clamping. A run that quietly dropped half its spectators, or that was cut off
 * mid-sequence by the gateway's own rate limiter, would still print a summary — and that summary
 * would describe a different test from the one the operator asked for. Failures name the
 * environment variable the operator sets, because that is what they can act on.
 */
export function planBaseline({ spectatorsPerNode, plies, moveIntervalMs }) {
  assertPositiveInteger('MOVE_PLIES', plies, MOVE_PLAN.length);
  if (plies < 2) {
    throw new Error('MOVE_PLIES must be at least 2 so one command crosses to the owning node');
  }
  assertPositiveInteger('MOVE_INTERVAL_MS', moveIntervalMs);
  if (!Number.isSafeInteger(spectatorsPerNode) || spectatorsPerNode < 0) {
    throw new Error(`SPECTATORS_PER_NODE must be a non-negative integer, got ${String(spectatorsPerNode)}`);
  }

  const perNode = spectatorsPerNode + 1;
  if (perNode > GATEWAY_LIMITS.maxConnectionsPerIp) {
    throw new Error(
      `SPECTATORS_PER_NODE=${spectatorsPerNode} needs ${perNode} sockets per node from one IP, ` +
        `over the gateway's WS_MAX_CONNECTIONS_PER_IP=${GATEWAY_LIMITS.maxConnectionsPerIp}. ` +
        'Sockets past the limit are closed with 1013, so the run would measure the limiter.',
    );
  }

  const frames = peakClientFramesPerWindow(plies, moveIntervalMs);
  if (frames > GATEWAY_LIMITS.maxMessagesPerWindow) {
    throw new Error(
      `MOVE_INTERVAL_MS=${moveIntervalMs} makes a player send up to ${frames} frames per ` +
        `${GATEWAY_LIMITS.messageWindowMs}ms, over the gateway's ` +
        `WS_MAX_MESSAGES_PER_WINDOW=${GATEWAY_LIMITS.maxMessagesPerWindow}. ` +
        'The gateway closes the connection with 1008 at that point.',
    );
  }

  return {
    moves: MOVE_PLAN.slice(0, plies),
    sockets: planSockets(spectatorsPerNode),
  };
}

/** The sockets to open, in open order: both players first, then the spectator gallery per node. */
function planSockets(spectatorsPerNode) {
  const sockets = [
    { id: `${PLAYER_NODES.white}-white`, node: PLAYER_NODES.white, role: 'white' },
    { id: `${PLAYER_NODES.black}-black`, node: PLAYER_NODES.black, role: 'black' },
  ];
  for (const node of NODES) {
    for (let seat = 1; seat <= spectatorsPerNode; seat += 1) {
      sockets.push({ id: `${node}-spectator-${seat}`, node, role: 'spectator' });
    }
  }
  return sockets;
}

function unexpected(reason) {
  return { kind: 'unexpected', reason };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validClock(clock) {
  return isRecord(clock) && Number.isFinite(clock.w) && Number.isFinite(clock.b);
}

function validTimeControl(value) {
  return (
    isRecord(value) &&
    ['unlimited', 'sudden_death', 'increment', 'delay'].includes(value.kind) &&
    Number.isFinite(value.initialMs) &&
    Number.isFinite(value.incrementMs) &&
    Number.isFinite(value.delayMs)
  );
}

function validStatus(value) {
  if (!isRecord(value) || typeof value.over !== 'boolean') return false;
  if (!value.over) return true;
  return (
    typeof value.result === 'string' &&
    typeof value.termination === 'string' &&
    (value.winner === null || value.winner === 'w' || value.winner === 'b')
  );
}

function validAuthoritativeState(state) {
  return (
    typeof state.variant === 'string' &&
    isRecord(state.players) &&
    typeof state.players.white === 'string' &&
    typeof state.players.black === 'string' &&
    validTimeControl(state.timeControl) &&
    typeof state.fen === 'string' &&
    typeof state.fenHash === 'string' &&
    (state.turn === 'w' || state.turn === 'b') &&
    validClock(state.clock) &&
    (state.turnStartedAt === null || Number.isFinite(state.turnStartedAt)) &&
    validStatus(state.status) &&
    (state.drawOffer === null || state.drawOffer === 'w' || state.drawOffer === 'b') &&
    Array.isArray(state.moves) &&
    isRecord(state.legalMoves)
  );
}

/** The `joined` acknowledgement must seat this connection where the plan says, in a fresh game. */
function classifyJoined(frame, expected) {
  if (expected.joined) return unexpected('received a duplicate joined acknowledgement');
  if (frame.role !== expected.role) {
    return unexpected(`joined as "${String(frame.role)}", expected "${expected.role}"`);
  }
  if (!isRecord(frame.state)) return unexpected('joined acknowledgement carries no game state');
  const ply = frame.state.ply;
  if (frame.state?.gameId !== expected.gameId) {
    return unexpected('joined state carries a different game than the one under test');
  }
  if (ply !== expected.nextPly - 1) {
    return unexpected(
      `joined a game at ply ${String(ply)}, expected ply ${expected.nextPly - 1} — ` +
        'the game under test is not the one this run created, or it has already been played',
    );
  }
  if (!validAuthoritativeState(frame.state)) {
    return unexpected('joined acknowledgement carries malformed authoritative state');
  }
  return { kind: 'joined' };
}

/** A move broadcast must be the next ply of the planned line, not a replay or a skipped one. */
function classifyMove(frame, expected) {
  if (frame.ply !== expected.nextPly) {
    return unexpected(`move broadcast at ply ${String(frame.ply)}, expected ply ${expected.nextPly}`);
  }
  if (frame.uci !== expected.nextUci) {
    return unexpected(
      `ply ${expected.nextPly} broadcast "${String(frame.uci)}", expected "${expected.nextUci}"`,
    );
  }
  if (frame.by !== expected.nextBy) {
    return unexpected(
      `ply ${expected.nextPly} broadcast by "${String(frame.by)}", expected "${expected.nextBy}"`,
    );
  }
  if (typeof frame.fenHash !== 'string' || frame.fenHash.length === 0) {
    return unexpected(`ply ${expected.nextPly} broadcast no position hash`);
  }
  if (
    typeof frame.san !== 'string' ||
    !validClock(frame.clock) ||
    !Number.isFinite(frame.serverTs) ||
    !isRecord(frame.legalMoves)
  ) {
    return unexpected(`ply ${expected.nextPly} broadcast a malformed authoritative move`);
  }
  return { kind: 'move' };
}

function classifyPresence(frame) {
  return typeof frame.white === 'boolean' &&
    typeof frame.black === 'boolean' &&
    Number.isSafeInteger(frame.spectators) &&
    frame.spectators >= 0
    ? { kind: 'presence' }
    : unexpected('presence frame is malformed');
}

/**
 * Decide what an incoming server frame is, or why it must fail the run.
 *
 * Everything outside `joined` / `presence` / `move` is a failure rather than something to skip.
 * A `reject` is the gateway refusing a command this plan proved legal; `ended`, `state`, `resumed`
 * and `pong` all mean the connection is in a state this baseline never asks for. Ignoring them
 * would let a run report clean fanout numbers for a game that had already finished.
 *
 * @param {unknown} frame parsed server frame
 * @param {{ gameId: string, role: string, joined: boolean, nextPly: number, nextUci: string, nextBy: string }} expected
 * @returns {{ kind: 'joined'|'presence'|'move' } | { kind: 'unexpected', reason: string }}
 */
export function classifyServerFrame(frame, expected) {
  if (frame === null || typeof frame !== 'object') return unexpected('frame is not a JSON object');
  const type = frame.t;
  if (type !== 'joined' && type !== 'presence' && type !== 'move' && type !== 'reject') {
    return unexpected(`unexpected server frame type "${String(type)}"`);
  }
  if (frame.gameId !== expected.gameId) {
    return unexpected(`"${type}" frame carries a different game than the one under test`);
  }
  if (type === 'reject') return unexpected(`gateway rejected a command (${String(frame.code)})`);
  if (type === 'presence') return classifyPresence(frame);
  return type === 'joined' ? classifyJoined(frame, expected) : classifyMove(frame, expected);
}

/**
 * Record the position hash broadcast for a ply, reporting any later disagreement.
 *
 * Every socket on both nodes must be told the same position for the same ply. A divergence here is
 * the failure mode multi-node fanout exists to prevent, and it is invisible to a ply counter:
 * two nodes can each deliver ply 7 on time and disagree about what ply 7 was.
 *
 * @param {Map<number, string>} seenByPly ledger, mutated in place
 * @returns {string|null} the reason this frame disagrees, or null when it agrees
 */
export function recordPosition(seenByPly, ply, fenHash) {
  if (typeof fenHash !== 'string' || fenHash.length === 0) {
    return `ply ${ply} broadcast no position hash`;
  }
  const first = seenByPly.get(ply);
  if (first === undefined) {
    seenByPly.set(ply, fenHash);
    return null;
  }
  return first === fenHash ? null : `ply ${ply} broadcast two different positions to the room`;
}

/**
 * k6's built-in `--summary-export` includes `setup_data`, which for this scenario contains both
 * access tokens. Select metrics explicitly so the on-disk artifact cannot persist credentials.
 */
export function metricsOnlySummary(data) {
  const input = data !== null && typeof data === 'object' && isRecord(data.metrics) ? data.metrics : {};
  const metrics = Object.fromEntries(
    Object.entries(input).map(([name, metric]) => [
      name,
      isRecord(metric) && isRecord(metric.values) ? metric.values : {},
    ]),
  );
  return JSON.stringify({ metrics });
}
