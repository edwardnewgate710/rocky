# ADR-0111 — A WebSocket baseline against the real two-gateway stack

| Field      | Value                                                        |
|------------|--------------------------------------------------------------|
| **Status** | Accepted                                                     |
| **Date**   | 2026-08-16                                                   |
| **Scope**  | `deploy/load`, `scripts`, CI wiring, current-state docs       |

---

## Context

Three things claim to cover the realtime path, and between them they leave a hole.

- `packages/realtime-gateway/test/load.test.ts` puts 50,000 idle and 5,000 active connections
  through the gateway and asserts p99 fanout under 50 ms. It does so **in-process**, against
  `InMemoryConnection` and a fake clock. It measures the algorithmic cost of fanout, which is the
  right thing for a unit test to measure and is not a socket, a network, or a container.
- `scripts/chaos-test.mjs` (ADR-0077) plays real moves over real sockets across two gateway nodes
  and proves cross-node correctness and failover. It does so with two to three connections.
- `deploy/load/scenarios/api-baseline.js` (ADR-0065) is the only thing that generates load, and it
  never opens a WebSocket.

So `docs/SLO.md` could say, accurately, that every gateway metric it lists "is registered but has no
baseline behind it". Nothing had ever driven concurrent sockets at the deployed gateway across a
container boundary — which is also the boundary where connection limits, message-rate limits, the
WebSocket upgrade, JSON framing and Redis forwarding actually live.

M14 still defers 100k-user validation, and that work needs a cluster and load generated from many
hosts. This is the much smaller question that comes first: **does the real gateway path work, and
what does it cost, when more than three sockets are attached to two nodes at once?**

## Decision

### 1. One scenario, both nodes, and a plan that forces the forwarding path

`deploy/load/scenarios/ws-baseline.js` registers the two players a real game needs, opens that game
through the public seek API, and then opens a bounded gallery of sockets on **both** gateway nodes.
White plays through node1 and black through node2.

That split is the whole point rather than a detail. Ownership is claimed by the first game *command*
(`RedisCommandRouter.route`), so white's opening move pins the game to node1 and every black move
after it has to be forwarded there over Redis. Seat both players on one node and the run still
passes — while measuring nothing but one node's local fast path.

### 2. No test-only endpoint, and no credentials outside k6 memory

Setup runs entirely over published contracts: `POST /v1/auth/register` twice, `POST /v1/seeks`,
`POST /v1/seeks/:id/accept`. Two accounts is the minimum a real game needs.

Access tokens are returned from `setup()` into VU memory and go nowhere else. In particular, the
WebSocket runner does not use k6's built-in `--summary-export`, because k6 serializes `setup_data`
into that artifact. The scenario's `handleSummary` writes a deliberately metrics-only JSON summary.
The contract test feeds representative tokens and setup data through that serializer and proves
none can enter the output. No error path interpolates a response body either: the registration
response *is* a live credential.

### 3. Coverage and correctness are thresholds; latency is not

The k6 thresholds are exact counts known before the run starts — every socket joins, every socket
receives every ply, zero protocol errors:

```js
ws_joins_observed:      ['count==34'],
ws_broadcasts_observed: ['count==1088'],
ws_protocol_errors:     ['count==0'],
```

Counts rather than rates, because a delivery rate of 1.0 is a statement about the deliveries that
arrived and says nothing about the ones that never did.

**The latency metrics deliberately carry no threshold.** ADR-0064 shipped three SLOs and admitted
they were guesses; ADR-0065 measured them so they would stop being guesses. Writing an end-to-end
WebSocket objective from one run on one workstation would put the repository straight back where
those two increments started. The numbers are reported, labelled informational, and recorded in
`docs/SLO.md` as a single-machine observation rather than as a target.

The in-process p99 < 50 ms figure is specifically **not** reused as a threshold here. It describes
fanout cost with a fake clock and no sockets; borrowing it would be a network claim backed by a
non-network measurement.

### 4. Anything unexpected fails the run

A `reject` is the gateway refusing a command the plan proved legal. `ended`, `state`, `resumed` and
`pong` all mean the connection is in a state this baseline never asks for. A `joined` frame for a
game already past ply 0 means the run attached to something it did not create. Every one of those
fails rather than being skipped, and every socket's view of each ply is compared by `fenHash`, so
two nodes cannot each deliver ply 7 on time while disagreeing about what ply 7 was.

### 5. The plan is a pawn stampede, not a famous game

The move sequence is every pawn advancing one square, file by file, colours alternating. Both
properties it needs are then provable by inspection rather than by having run it once: every move is
legal (single steps into empty squares, no king ever attacked), and no position can repeat, because
a pawn advance is irreversible — which matters because this engine ends a game on threefold
repetition. An opening line that ended in mate, or a piece shuffle that repeated a position, would
fail the run for reasons that have nothing to do with the gateway.

### 6. The harness stays under the production limits it runs into

The gateway allows 20 connections per source IP per node (`WS_MAX_CONNECTIONS_PER_IP`) and 60 client
frames per connection per 10 s (`WS_MAX_MESSAGES_PER_WINDOW`). k6 generates all its load from one
container, so the gateway sees every socket as one IP and the per-IP ceiling — not the hardware — is
what bounds this baseline.

Those limits are **not** relaxed, and no load-only Compose override ships. The default configuration
sits at 17 sockets per node, and `planBaseline` refuses a configuration that would cross the
connection limit. Its message-rate calculation is finite: the default plan sends at most one join
plus 16 moves on a player socket, safely below 60 frames even at the fastest accepted pacing.
Raising an abuse control to make a number look better would make the number describe a service
nobody deploys.

### 7. Forwarding is proved by a counter, not by a successful handshake

`scripts/ws-load-test.mjs` brackets the k6 run with the two things k6 cannot see from inside a
socket: both nodes must report `commandRouting: redis` on `/health`, and
`gateway_forwarded_commands_total` summed across both nodes must grow by exactly the number of
commands the isolated plan sends to the non-owning node. Two gateways that were each routing locally would
answer every health check and serve every socket, and the run would look identical.

`gateway_forward_latency_seconds` is untouched and is still not an end-to-end SLI: it measures one
hop and never sees a fast-path command. The new `ws_move_*` trends are client-observed and separate.

### 8. Shared runner mechanics, separate runners

`scripts/lib/k6-docker.mjs` holds the pinned image, the mount layout and the host-gateway alias;
`scripts/load-test.mjs` and `scripts/ws-load-test.mjs` each keep their own health checks and their
own reporting. The pin is the part that must not be stated twice — ADR-0065 pinned `grafana/k6`
because "a baseline measured with a drifting tool is not a baseline", and two copies of a version
pin are two versions waiting to disagree. Environment values reach the container as `docker -e`
argv entries with no shell in between.

### 9. The harness's own guards are tested, and CI runs them

`npm run test:load-harness` exercises the pure planning and frame-verification logic directly. The
k6 scenario cannot be executed by `node --test` — it imports `k6/*` — so the guards that decide
whether a run is real live in `deploy/load/scenarios/lib/ws-baseline-plan.mjs` and are tested there
directly. One deliberately narrow source contract also protects the credential boundary that must
remain in the k6-only module: `handleSummary` must call the metrics-only serializer, and scenario
code must not write setup credentials through `console`.

It runs in CI's `build-test` job even though the load test itself does not. The load run needs a
stack and a workstation; its correctness guards are pure functions and a few file reads. Leaving
them unrun is how an on-demand harness quietly stops testing what it claims to.

## Consequences

- The gateway path has a baseline. `docs/SLO.md` no longer has to say the realtime path is entirely
  unexercised, and can say what was exercised and at what size.
- **Still no WebSocket SLO, and no capacity figure.** 34 sockets on one workstation is a floor for
  correctness and an upper bound on latency, nothing more. One k6 VU drives every socket on
  one event loop, so the reported latencies include client-side queueing.
- **Two registrations per run, against a 5-per-hour-per-IP limit.** That is roughly two runs per
  hour from one host, and it is a property of the abuse control working as designed (ADR-0013), not
  something to work around. `deploy/load/README.md` says so.
- Not wired into CI, for the same reason as ADR-0065: a load test on a shared runner measures the
  runner's neighbours, and a flaky performance gate teaches people to ignore gates.
- What remains unmeasured is unchanged in kind and stated in `docs/SLO.md`: many source IPs, many
  concurrent games, reconnect/resume under load, sustained soak, and the deferred 100k validation.
- The scenario uses the global event loop in pinned k6 0.55.0's `k6/experimental/websockets` API.
  A k6 upgrade must revalidate that one-VU ownership and the custom summary behavior before its
  measurements are compared with this baseline.
- That experimental API cannot cancel a WebSocket constructor still waiting on a blackholed
  address. The runner's health precheck prevents a known-down gateway from entering that path, but
  the per-socket JavaScript timeout is not a hard bound on an operating-system connect attempt.
