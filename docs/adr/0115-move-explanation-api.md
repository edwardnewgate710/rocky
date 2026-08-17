# 115. Move Explanation as a Production API Capability

Date: 2026-08-17

## Status

Accepted

## Context

M8 shipped eight AI features in `@chess-platform/ai-features`, and the ROADMAP records it complete.
It is complete as a library and was never composed: before this increment, **nothing outside that
package imported it**, and `new AiOrchestrator` appeared only in `ai-orchestrator`'s own tests. There
was no env-driven AI configuration anywhere in the repository — `grep process.env` across
`packages/ai-orchestrator/src` returned nothing.

That is not a criticism of M8, which set out to build the domain layer and did. It is the distinction
this ADR exists to record: **a library implementation is not a product capability**, and the roadmap
entry did not say which one it was describing. `FEATURE_PARITY_AUDIT.md` already said
"Library/test implementation only" and needed no correction.

This increment productizes exactly one of the eight — Move Explanation — behind the same
optional-dependency → capability pattern as ADR-0106 and ADR-0113. The other seven remain
library-only and are explicitly out of scope.

## Decisions

### 1. Move Explanation borrows the analysis subsystem; it owns no engine — ADOPTED

ADR-0113 gave the API one dedicated analysis pool with a published CPU ceiling
(`maxWorkers × threadsPerWorker`), divided across pools so that adding a second engine cannot
silently double it. A second consumer building its own `EngineManager` would defeat that in the most
expensive possible way: the ceiling would remain accurate about each pool and wrong about the
process.

So `MoveExplanationService` calls the existing `AnalysisService`, inheriting its limits policy, its
FEN validation, its deterministic timeout, its queue and its pool.

The guarantee is structural rather than conventional. `MoveExplainerOptions.engine` is now optional,
and `createMoveExplanation` composes the explainer **without one**, supplying `ExplainRequest.analysis`
on every call. There is no parameter through which a second engine could arrive, so "no second pool"
is not a rule someone has to remember at review time — it is a thing that cannot be expressed.

### 2. Grounding has one owner, and it is the orchestrator — ADOPTED

`MoveExplainer` called `buildGroundedMessages()` itself **and** set `CompletionRequest.grounding`.
`AiOrchestrator.complete` builds grounded messages whenever `grounding` is present, and
`buildGroundedMessages` inserts after a leading system message — so the prompt reaching the provider
carried the same block of engine facts twice: a verbatim repeat spending context window and giving
the model two copies to reconcile.

It survived because the assertion covering it was `systemMessages.length >= 1`, which is equally true
of one copy and of two.

Fixed at the layer that owns it rather than by editing prompt text: features supply structured facts,
the port renders them. The test now asserts the count is exactly one, and mutation-checking confirms
that restoring the old two-step fails it.

This ADR does not change the other seven features, which have the same shape. They are library-only,
so nothing they do reaches production, and fixing them is a separate bounded change — recorded here
so it is a known follow-up rather than a discovery.

### 3. Features depend on a completion port, not on `AiProvider` — ADOPTED

`MoveExplainerOptions.ai` was typed `AiProvider`, which is the *adapter* contract — `id`,
`discoverCapabilities`, `healthCheck`. `AiOrchestrator` does not implement it and should not: it has
no id, no capabilities of its own to discover, and no health but its providers'. Typing features
against `AiProvider` therefore forced them to hold one raw vendor adapter, bypassing routing,
failover, caching, rate limiting and grounding — every control the orchestrator exists to apply.

`CompletionPort` is the one method a feature actually needs. `AiProvider` now extends it, so every
existing adapter and `FakeProvider` still satisfy it and no test double changed, while production can
inject the orchestrator.

### 4. The variant is part of the grounding — ADOPTED

`EngineGrounding` carried no variant, and the prompt never named one, so the model was asked to judge
a move under rules it had not been told. In Atomic or Racing Kings the same position with the same
evaluation means something entirely different.

It is also cache identity. `buildCacheKey` hashes the grounding, so before this change two variants
sharing a FEN, a move and an engine evaluation collided on a single cached explanation — one variant
could be served the other's answer. Adding the field fixes the correctness gap and the aliasing in
the same place. `positionHash`, documented as suitable for cache keys and unused so far, had the same
hole and is fixed with it.

Separately, `MoveExplainer` defaulted to variant `chess` — a value in no platform vocabulary. It
fails `parseVariant` at the API boundary and matches no engine pool below it, so the default named
something this system cannot serve anywhere. It is now `standard`, with a regression test.

### 5. The request body has three fields, and none of them is a knob — ADOPTED

`POST /v1/ai/move-explanation` accepts `fen`, `variant` and `move`. `strictObject` rejects anything
else, so a request cannot carry a model, a provider, a temperature, a token count, a cost ceiling, a
latency budget, a search depth, a movetime or a prompt.

Every one of those is fixed at composition time from the environment, and each env variable is
clamped to the compiled default as a *ceiling* — `AI_MAX_OUTPUT_TOKENS` can lower the limit and
cannot raise it, the same shape `analysisLimitsPolicyFromEnv` already had.

`side` is deliberately not accepted. The FEN determines who is to move, so the service derives it;
taking a caller's word for it would let a request tell the model that the other player made the move.

### 6. One request costs two searches and a bounded number of completions — ADOPTED

The amplification budget is stated rather than implied: exactly **two** engine searches
(`multiPv: 1` each), and at most `maxFailoverAttempts` provider calls, default **2**, each bounded by
`latencyBudgetMs` (default 15s) which the orchestrator enforces with an `AbortController`.

Two, not one, and the reason is Decision 6b: an explanation of a move needs the evaluation of that
move, which is a different position from the one the caller supplied. The first draft of this ADR
claimed one search and was wrong about what the feature does, not merely about the number.

Order matters as much as the numbers. Authentication, variant support, FEN validity and **move
legality** are all resolved before either subsystem is touched, so a rejected request costs a move
generation — not a search, and never a paid completion.

Rate limiting sits *between* those checks and the work, not at the top of the handler. Charging on
arrival meant a stream of malformed FENs or illegal moves — none of which reach an engine — could
empty a user's 10/min budget, and through the shared per-IP bucket, their neighbours' too. So
`explain` takes an `onAccepted` callback and the route spends its quota there: after the request is
known to be real, before anything is spent on it. Raised in the Qodo review of PR #134.

The callback exists rather than a separate `validate()` method because validation and execution have
to stay in one place. Split them and they drift, and the checks that keep an unroutable variant away
from the engine are precisely the ones that must not become skippable.

The per-user limit (10/min) is the real control; the per-IP limit (30/min) is deliberately not a
multiple of it, because a shared NAT puts many legitimate accounts behind one address and an IP-only
ceiling would ration them collectively.

### 6b. The move is analysed, not just the position — ADOPTED

The first cut validated the requested move and then analysed the **unchanged** position. With
`multiPv: 1` that returns the engine's own preferred continuation, so the citation described whatever
the engine would have played rather than what the caller asked about. Explaining a quiet move showed
the evaluation of a tactic the player never made; explaining a blunder showed the evaluation of the
best reply. The prose was grounded, and grounded in facts about a different move — the exact failure
the grounding requirement exists to prevent, arrived at from the opposite direction. Raised in the
Qodo review of PR #134.

`Position.play` already returned the resulting position and the code discarded it. It is now kept and
analysed, so each request runs two searches: the position as the player found it, and the position
they created. The gap between the two evaluations *is* the judgement — a move is good or bad only
relative to what was available instead.

Both evaluations are normalised to **the player who made the move**. UCI reports from the side to
move, which is the mover before the move and the opponent after it, so the post-move score is
negated — mate scores included, or a forced win reads as a forced loss. `EngineGrounding` gained
`moveEvalCp`/`moveEvalMate` for this, and the citation carries both numbers plus `bestMove`, so a
caller can see the comparison without inferring it from prose.

The cost is honest: this doubles the engine work per request, which is why Decision 6 says two.

### 6c. The FEN is validated at this boundary, before anything is derived from it — ADOPTED

Adding the second search exposed a gap. `AnalysisService` validates the FEN it is handed, but the
post-move search is handed a FEN this service *re-serialises* from a parsed position — structurally
clean by construction. So a FEN carrying a line terminator was rejected on the first search and
accepted on the second, and a request that correctly answered 422 had still spent an engine search.

`parseFen` does not catch it either: it splits on whitespace, so a trailing `\nquit` parses as an
ignored extra field. The character allowlist is what sees it. The service now runs `coreFenValidator`
itself, before `Position` is built and before either search — found by an existing injection test
that asserts the provider is never reached, which failed the moment the second search was added.

The orchestrator's cost ceiling is left **off** (`0`). It filters on model price metadata, and this
composition has no trustworthy price list; declaring invented prices would produce a control that
looks enforced and is arbitrary. The real cost bounds are the token ceiling, the failover cap and the
rate limit. Recorded rather than quietly configured.

### 7. Move legality is checked authoritatively, because the core can — ADOPTED

`Position.fromFen(fen, variant).play(move)` resolves the UCI against generated legal moves, so this
rejects a move not present in the position, one that leaves its own king in check, an off-rank
promotion and a Crazyhouse drop from an empty pocket. It is real adjudication.

The regex in the service is a shape filter and is documented as one — it bounds input before a
`Position` is built and could not distinguish legal from illegal. ADR-0113 was once wrong in exactly
this way, describing `parseFen` as an authoritative legality check when it decodes without
adjudicating; that error is not repeated here.

FEN validation itself remains where ADR-0113 put it, at the analysis boundary, which is the layer
that owns the UCI command-injection surface.

### 7b. The prompt cannot be steered by the request — ADOPTED

Both caller-supplied strings reach the prompt, so both are constrained before they get there.

The FEN passes `structuralFenValidator`'s character allowlist (`packages/engine/src/fen.ts`), which
admits only piece letters, digits, `/`, `w`/`b`, castling and en-passant characters, Crazyhouse
brackets and spaces. No newline, no punctuation, no prose — a valid FEN has nowhere to hide an
instruction. It then passes `parseFen` and the king-count check. The move passes a shape filter and
then `Position.play`, so it is a legal move in that position or the request never reaches the model.

That makes prompt injection through this endpoint structurally unavailable rather than filtered:
there is no free-text field. The same allowlist is what stops the FEN becoming an injected UCI
command one layer down (ADR-0113), and both checks run before the prompt is assembled.

The `side` value is derived from the parsed position rather than accepted, so it cannot contradict
the FEN either.

Note on defence in depth: mutation-testing showed that deleting the UCI shape regex changes no
observable behaviour, because `Position.play` rejects the same inputs. It is kept as a bound on what
reaches position construction, and it is documented in the code as a filter rather than as the
legality check — the claim and the code agree.

### 7c. An empty search produces no explanation — ADOPTED

A search can finish without emitting an `info` line, and empty analysis was the one input that could
have reached the model with nothing to defer to. `MoveExplainer` reads empty pre-computed analysis as
"none supplied" and falls through to its own engine — which this composition does not have — so the
observable result would have been a 500. The version of that fallback which *succeeds* is worse: its
no-results citation reports `+0.00` at depth 0, a number no engine produced, presented beside prose
the model wrote unaided.

The service now refuses with 503 before calling any provider. Found while re-reading the service
after the mutation run rather than by a failing test, which is why the covering test asserts the
provider was not called at all and not merely the status code.

### 8. Provider failures are opaque to the caller — ADOPTED

Every branch of `toHttpError` returns a fixed string. `AiError.message` is built from the vendor's own
response body — `openai-adapter.ts` reads `error.message` straight out of it — so forwarding it would
relay a third party's text and whatever it chose to say about our account, key, organisation or quota.

All of them map to 503, including `auth_failed`: a missing or rejected key is a deployment fault, and
answering 401 would be a false statement about the *caller's* credentials. Anything that is not an
`AiError` is rethrown so a genuine bug surfaces as a 500 instead of being disguised as a transient
provider problem — the rule `analysis/service.ts` already follows.

The response carries `providerId` and `model` and nothing else about the provider: no token usage, no
cost, no latency, no finish reason, no prompt.

### 9. Providers are configured, never discovered, and never defaulted — ADOPTED

`AiOrchestrator.registerProvider` calls `discoverCapabilities()`, which the OpenAI-compatible adapter
implements by listing models over HTTP. Registering that way would make process start-up depend on a
vendor being reachable and would make `createPgDependencies` async for a round-trip whose answer is
already known. Capabilities are supplied statically to `ProviderRegistry.register`, which is
synchronous, so composition is a pure function of the environment and boot performs no I/O — asserted
by a test that fails if `fetch` is called during composition.

A deployment with no `AI_*` variables composes nothing. There is no fallback vendor: a deployment that
did not ask for an external AI provider must not acquire one by starting up.

One adapter covers OpenAI, DeepSeek, OpenRouter and a local Ollama, since they share a wire format and
differ by `baseUrl`; Anthropic has its own. No route, service or schema names a vendor.

### 10. The capability implies analysis, and publishes no second variant list — ADOPTED

`moveExplanation` is true only when an AI provider **and** the analysis subsystem are both composed.
"AI configured, no engine" composes nothing rather than degrading to an ungrounded opinion, which is
the failure mode the grounding requirement exists to prevent.

The variants it can serve are therefore exactly `analysisVariants`, already published for ADR-0114.
A second list would be the same list in a second place, free to drift; a test asserts the equality
instead. The client reads it through the existing memoised `loadCapabilities`, whose response-envelope
fix from PR #133 is unchanged — no second capability-fetch mechanism is introduced.

## What is NOT covered

- **The other seven M8 features** remain library-only. This ADR productizes Move Explanation alone;
  Puzzle Generator, Mistake Predictor, Coach, Opening Explorer, Endgame Trainer, Study Partner and
  Tournament Commentator are untouched, including their duplicated grounding (Decision 2).
- **No UI.** Inc 4 consumes this endpoint; nothing in the browser calls it yet.
- **No client-disconnect cancellation.** `RequestContext` still exposes neither an `AbortSignal` nor
  the raw request (ADR-0113), so an abandoned request still costs its search and its completion.
  Internal deterministic timeouts apply throughout.
- **No cost accounting.** Nothing meters or reports spend per user or per deployment; the controls
  here are ceilings, not a budget.
- **No capacity claims.** Nothing here was load-tested. The engine defaults are unchanged, and no
  statement is made about concurrent explanation throughput.
- **No paid provider in CI.** Every test is hermetic, using `FakeProvider` and a stub analysis
  provider. No test requires or reads a real credential.
