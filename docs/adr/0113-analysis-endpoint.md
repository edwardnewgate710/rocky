# 113. Engine Analysis Endpoint with a Dedicated Analysis Pool

Date: 2026-08-17

## Status

Accepted

## Context

`@chess-platform/engine` has been complete and green since M5: a provider-agnostic UCI bridge with
pooling, priority scheduling, cancellation, watchdogs, a circuit breaker and graceful shutdown,
behind one interface — `AnalysisProvider`. Since ADR-0080/0102 it is also composed in production:
`Dockerfile.gateway` installs Stockfish and `services/gateway/src/serve.ts` builds a shared
`EngineManager` for the bot mover and the anti-cheat auto-analyzer.

What has never existed is a way for a *user* to ask for analysis. There is no `/v1/analysis` among
the API's route prefixes, and `packages/ai-features` — move explainer, puzzle generator, opening
explorer, endgame trainer, coach, mistake predictor — has no importer outside its own tests. Every
one of those features needs the same primitive first: evaluate this position, return the lines. This
increment ships that primitive and nothing else.

`docs/FEATURE_PARITY_AUDIT.md` describes this gap as "Compose starts no engine worker and the API
exposes no analysis endpoint." The first half has been stale since ADR-0102; the second half is what
this ADR closes. The stale half is corrected in the same change, because this ADR would otherwise
contradict the audit on the very topic it covers.

## Decisions

### 1. Analysis gets a dedicated engine pool; the gateway pool stays for gameplay — ADOPTED

The gateway already owns a warm `EngineManager`. Reusing it was rejected.

Analysis is a CPU-amplification surface: one cheap HTTP request buys seconds of multi-core search.
Bot moves are on a human's clock. Sharing one pool puts a discretionary, user-triggered, unbounded-
in-aggregate workload in the same queue as a latency-critical one. `JobPriority` (`BotMove` <
`LiveAnalysis`) would order them, but ordering is not isolation: analysis jobs already dispatched
still occupy workers, and the scheduler's aging deliberately promotes waiting jobs, so a sustained
analysis load degrades bot latency by design rather than by accident.

Separate pools also give the two workloads independent concurrency, backpressure and rate-limit
policy, separate failure isolation (an analysis circuit trip cannot open the bot circuit), and
metrics that mean one thing each.

The pool is therefore owned by the API-side analysis composition and is a distinct `EngineManager`
instance. Because the API and the gateway are separate deployables, this is process-level isolation,
not merely object-level.

### 2. Analysis is hosted by the API, not the gateway and not a new service — ADOPTED

Three placements were considered.

**The API (adopted).** All REST lives here: the router, `requireAuth`, the rate limiter, the
`HttpError` taxonomy, the OpenAPI spec, and the optional-dependency → capability pattern used by
seven subsystems already. The endpoint costs no new infrastructure.

**The gateway (rejected).** It has the binary and a manager already, but it is the WebSocket edge
with only a health HTTP server. Adding REST there means rebuilding routing, validation, auth and
OpenAPI, and splitting the public API across two origins — which contradicts `resolveEndpoints` in
`packages/web/src/app/config.ts` and the nginx `/v1` proxy.

**A dedicated analysis service (rejected *for now*, not foreclosed).** This is the right answer at
scale and ADR-0002 anticipated it ("distributed remote workers"). It is not the smallest first
increment: a new deployable, image, Compose entry, health contract and inter-service protocol,
justified by no measurement. Crucially, deferring costs nothing later — callers depend only on
`AnalysisProvider`, so moving the work out of process is a transport swap behind an unchanged public
contract.

### 3. A wall-clock ceiling is applied unconditionally — ADOPTED

This is the decision the endpoint's safety rests on.

`AnalysisLimits` lets a caller bound a search by `depth`, `nodes` or `timeMs`, and the engine stops
at whichever arrives first. A request carrying only `depth: 30` is therefore *unbounded in
wall-clock time* — it runs until that depth completes, which on a complex position is not a bounded
quantity. Validating `depth <= 20` at the edge does not fix this; it only shapes the work below a
ceiling that is not there.

`applyAnalysisLimits` (`packages/api/src/analysis/limits.ts`) therefore injects `timeMs` on every
request whether or not the caller mentioned time, so every search is bounded in two independent
dimensions and neither can be removed by omitting a field.

Three layers enforce it, deliberately redundant: the route rejects out-of-range input with 422 (a
caller who asks for depth 40 is told the limit rather than silently capped); `applyAnalysisLimits`
clamps regardless, so a future call path that skips route validation still cannot exceed policy; and
the service arms an `AbortController` as a backstop against an engine that stops honouring its own
limit. Limits are built field-by-field rather than spread from the caller's object, so an unexpected
property cannot ride into the engine request.

Configuration may **tighten** limits but never loosen them past the built-in ceilings, and any
unparseable, zero or negative environment value falls back to the safe default. Environment is
configuration, not an escape hatch.

### 4. Saturation is signalled, not absorbed — ADOPTED

Bounded concurrency and backpressure use the pool's own tested machinery rather than a second queue
in front of it: `maxWorkers` (default 2) bounds concurrency and `capacityPerClass` bounds the queue.
The engine package's default capacity of 1000 per class is far too permissive here — the point of a
bound on a CPU-amplification surface is that saturation is refused quickly — so the analysis pool
sets **32**. `QueueFullError` and `CircuitOpenError` surface as `503` with `Retry-After`.

`minWorkers` is **0**: no engine subprocess exists until the first request, so a deployment that
never analyses pays nothing, and `warmup()` is deliberately not called (it floors the target at 1).

### 5. Positions are validated by the rules engine, at the API boundary as well as in the engine — ADOPTED

`@chess-platform/engine` ships `StructuralFenValidator` as its safe default and documents that the
deployable service may inject a `@chess-platform/core`-backed validator. This increment does that.
The structural validator runs first — it bounds length and enforces a character allowlist before
anything attempts to parse — then `parseFen` decodes, then a king-count check runs.

The king-count check exists because an earlier draft of this ADR claimed `parseFen` performed "the
authoritative legality check", and the Qodo review of PR #132 showed it does not: it decodes a FEN
and accepts an empty board, a lone king, or two white kings. Those are not chess positions, and each
was reaching a native engine whose behaviour on them is undefined.

The expected counts are read from each variant's own `Position.initial(...)` rather than hardcoded,
which is what makes Horde — no white king at all — validate correctly instead of being refused by a
blanket "one king each" rule. King count is invariant across a game: kings are never captured, and
in Atomic an explosion ends the game.

**This still does not make the validator an authoritative legality check, and this ADR should not be
read as claiming one.** Side-not-to-move already in check, pawns on the back rank, and castling
rights without the pieces to support them are all accepted. Full legality is a larger surface than
this increment needs; the king count is the check that separates a position from a shape, and the
one the engine's behaviour actually depends on.

`AnalysisService` runs that validator itself, rather than relying on the one inside `EngineManager`.
The security review of this increment found the reason. UCI is newline-delimited and
`buildPositionCommand` interpolates the FEN into a `position fen ...` line written to the
subprocess's stdin, so a FEN carrying a line terminator is not a malformed position — it is a second
command chosen by the caller. `setoption name Threads value 128` is the one that matters, because
every ceiling in Decision 3 bounds the *search* and none of them bounds how many cores serve it.

The engine's allowlist does reject that, on a detail worth writing down: in JavaScript `$` matches
only at the very end of the input, so a trailing terminator is refused. The same expression in
Python would accept it. But that check lived entirely inside the provider — a component the API does
not own and, by Decision 2, intends to replace with a remote worker behind the same interface. On
the day that lands, the in-process manager and its validator both disappear and the FEN starts
crossing a network unvalidated, with every existing test still green. Validating at the boundary the
API does own closes that before it can open. It costs a regex and a parse.

A bare trailing newline with nothing after it is not refused: the route reads `fen` with
`trim: true`, so it arrives as an ordinary valid FEN. That is correct — no terminator survives, so
there is no second command — and the tests assert the actual invariant (no FEN reaching a provider
contains a line terminator) rather than the status code that usually accompanies it.

### 6. Errors reuse the existing taxonomy — ADOPTED

`ErrorCode` in `packages/api/src/http/errors.ts` is a closed union, and widening it would change the
public error contract for every route. Transient engine failures therefore map onto the existing
`service_unavailable`, distinguished by message rather than by code.

Engine-internal failures (`engine_crashed`, `protocol`, `engine_version`, `not_initialized`) return a
fixed generic message. Those errors can carry binary paths and engine internals, and `HttpError`
messages are surfaced to clients. Anything that is not an `EngineError` is rethrown untouched, so a
genuine bug surfaces as a 500 rather than being disguised as a 503.

### 7. The response contract is the primitive the AI features share — ADOPTED

One line carries `multipv`, `evaluation` (`cp` or signed `mate`), the principal variation, `depth`,
`nodes` and `timeMs`. That is what a move explainer, a mistake predictor, a puzzle generator and a
coach each need, and it is deliberately free of anything specific to any of them — none of those
features is designed here.

The response echoes the `applied` limits. A caller whose request was capped can see it, and the cap
becomes observable rather than a silent server-side surprise.

Variants are not special-cased. Routing asks the engine's discovered capabilities, per ADR-0102, so
an engine that does not support a variant produces a clean rejection rather than a wrong answer.
Chess960 remains withheld at the product level (ADR-0099) and needs no handling here.

## What is NOT covered

- **No analysis UI.** No page, no eval bar, no client binding beyond the capability flag.
- **No AI features.** Move explainer, puzzle generator, opening explorer, endgame trainer, coach and
  mistake predictor stay library-only; this increment only gives them something to build on.
- **No dedicated remote engine service.** Deferred by Decision 2, preserved by `AnalysisProvider`.
- **No durable analysis cache.** The in-process LRU is the shipped default; ADR-0003 and the
  `DATABASE.md` contract are untouched.
- **No cancellation on client disconnect.** `RequestContext` exposes neither an `AbortSignal` nor the
  raw request, so abandonment is not observable at the route layer. Timeout-driven cancellation is
  implemented and does exercise the provider's real `signal` path; plumbing a per-request signal
  through the shared HTTP layer would touch every route and is tracked as a follow-up.
- **No capacity claims.** The defaults are chosen to be obviously affordable, not tuned. No load
  testing has been performed against a real deployment.
