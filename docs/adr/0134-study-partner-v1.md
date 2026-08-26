# ADR-0134 — Server-authoritative Study Partner v1

| Field      | Value                                                        |
|------------|--------------------------------------------------------------|
| **Status** | Accepted                                                     |
| **Date**   | 2026-08-24                                                   |
| **Scope**  | API, persistence, OpenAPI, typed web client                  |

---

## Context

ADR-0133 deliberately did not adapt the production `CoachService` to the library `CoachPort`.
That port promises solution-rich library values and cannot preserve production omission reasons,
answer withholding, deferred charging, or cancellation. Study Partner also had only an in-memory,
caller-position-driven library lifecycle: no account ownership, durable state, optimistic
concurrency, deletion contract, or HTTP surface.

The v1 product decision requires a private linear session whose position transitions are controlled
by the server and whose one coaching operation per turn uses the same hardened path as
`POST /v1/coach`.

## Decision

### 1. One server-owned line

Creation accepts exactly `variant` and `initialFen`. The API validates and canonicalizes the FEN,
then persists both the initial and current position. A turn accepts exactly a UCI `move` and
`expectedVersion`, plus a required `Idempotency-Key` header. It never accepts a current/next FEN,
progress, coaching output, engine limits, provider, model, or token policy.

The service loads the owner-scoped session, applies the move with `Position` under the stored
variant, derives the next FEN, calls the production `CoachService` once on the position *before* the
move, and atomically inserts the turn and advances the session. There is no library `Coach`, raw
Study Partner narrative, adapter to `CoachPort`, branch, undo, arbitrary jump, or collaboration.

V1 supports `standard` only. This is a truthfulness bound, not an engine limitation: the platform's
ordinary six-field FEN serialization cannot preserve Three-Check counters, and this feature promises
that its stored FEN is the complete authority. Adding a variant requires proving its persisted
position codec round-trips all rule state.

### 2. Durable turn intent precedes expensive work

`study_partner_sessions` and `study_partner_turns` hold normalized product state. A third,
operational table, `study_partner_turn_requests`, is required for the idempotency promise. Checking
an idempotency key only when the turn is appended leaves a window in which two concurrent requests
both purchase coaching and only one commits.

The request table therefore claims `(session_id, idempotency_key)` before `CoachService` runs and
allows at most one `claimed | accepted` request for a session at a time. `CoachService.onAccepted`
changes the claim to `accepted` before the existing two-bucket `coach` rate-limit admission. A
successful final transaction inserts the turn, advances FEN/version/count, and marks the request
`succeeded`. A completed same-payload replay returns the stored turn without Coach or quota work.
The same key with another payload is 422; pending/accepted/failed keys are 409. An accepted intent
that cannot commit becomes `exhausted`. The same `(session, move, expectedVersion)` request hash is
then 409 across every idempotency key, so changing the key cannot purchase the same intent again.

A process crash can leave a request claimed or accepted. `claimed` is provably before the charge
callback, so `claimTurn` transactionally fails it after five minutes and allows a new key; this is
request-path recovery, not a background retention job. `accepted` is beyond an ambiguous
charge/provider boundary. A caught failure immediately exhausts it; an orphaned accepted row becomes
exhausted after the one-hour accepted-work window when claim, end, or delete next locks the session.
Exhausted rows are terminal and never replayed or reclaimed. They release the session, but their
request hash remains a durable purchase barrier. A genuinely different move has another hash and may
continue from the unchanged version; the owner may also end or delete the session.

### 3. Private ownership and lifecycle

All five routes require authentication. Every repository read/write scopes by owner; foreign and
missing IDs both return 404. `end` checks optimistic version while active, refuses an in-flight turn,
and changes the session once. Re-ending returns the stored completion and never rewrites
`completedAt`. Owner deletion locks the session and returns 409 for a fresh `claimed` request or for
one hour after a request becomes `accepted`, so it cannot erase ordinary in-flight work after
production coaching accepts its charge. After that conservative safety window, accepted work is
exhausted and privacy deletion or normal session completion is allowed. Otherwise deletion is a hard
delete; session, turns, and request claims cascade in the same database operation. Account deletion
cascades through the owner FK. There is no TTL or list endpoint; data remains until deletion.

Turn history is bounded at 20. This bounds the single-session GET response, coaching move ledger,
storage exposure, and cost of a session without introducing pagination or listing into v1.

### 4. Persist only a versioned safe coaching projection

Each turn stores projection version `1` and tagged `present | omitted` sections with the production
omission reason. The puzzle projection has no solution move or line; the endgame projection has no
solution or evaluation answer. Move explanation is copied field by field and drops `providerId` and
`model`. No prompt, provider response, usage, latency, raw library narrative, or `featuresFired`
ledger is stored or returned.

Request cancellation is passed to `CoachService`. If the signal is aborted before final commit, the
result is discarded and neither a partial turn nor a position advance is persisted. A pre-acceptance
request becomes `failed` and may be retried with a new key. An accepted request becomes `exhausted`,
so the same intent remains blocked across new keys because admitted work may already have cost money.

### 5. Surface and composition

The API exposes only:

- `POST /v1/study-partner/sessions`
- `GET /v1/study-partner/sessions/:id`
- `POST /v1/study-partner/sessions/:id/turns`
- `POST /v1/study-partner/sessions/:id/end`
- `DELETE /v1/study-partner/sessions/:id`

OpenAPI documents the required idempotency header, strict bodies, bounded history, safe coaching
shape, and conflicts. The public capabilities response reports `studyPartner` from the composed
service. The web package exposes a typed client for the five operations; a visual workflow is not
part of this production slice.

## Consequences

The API now offers a production Study Partner lifecycle without weakening CoachService policies or
letting callers manufacture a position transition. Successful retries are cheap and exact, two
concurrent turns cannot both run coaching, completion is stable, and privacy is enforced below the
route layer.

Accepted-work recovery favors no duplicate purchase without permanently blocking the session: the
same intent cannot be bought again, while another legal move, end, and delete remain available after
the protection window. Standard is the only v1 variant. Both are explicit constraints clients can
build against rather than silent best-effort behavior.

## Explicitly deferred

- Study/chapter integration, branching, undo, collaboration, and arbitrary position jumps.
- Anonymous sessions, listing/discovery, TTL retention, analytics, and background cleanup.
- Library Study Partner narrative, Voice Coach, speech providers, curriculum generation.
- Visual Study Partner UI.
- Downstream replay of an accepted-but-uncommitted coaching result, and additional variants.
