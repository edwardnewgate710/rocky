# ADR-0133 — `CoachPort`, and why the production `CoachService` is not made to satisfy it

| Field      | Value                                                  |
|------------|--------------------------------------------------------|
| **Status** | Accepted                                               |
| **Date**   | 2026-08-24                                             |
| **Scope**  | `packages/ai-features`                                 |

---

## Context

`StudyPartner` and `VoiceCoach` took the concrete `Coach` class:

```ts
readonly coach: Coach;
```

That is the blocker `PROJECT_STATE.md` records against Study Partner — "the library `Coach` is not what
production runs". A production caller could satisfy those constructors only by building a *second*
library `Coach`, which would bypass every policy the API's `CoachService` applies (ADR-0129): the
standard-only opening gate, the 60-ply ceiling, terminal adjudication, answer withholding, per-section
degradation, and sequential execution for cost. Depending on the class also bound both consumers to
its entire surface, when between them they call exactly one method.

## Decision

### 1. The port is one operation wide, because that is what the consumers use

Read from the call sites, not from the class:

- `study-partner.ts` — `await this.coach.coach({ fen, move?, moves? })`
- `voice-coach.ts` — `await this.coach.coach(request)`

One method, twice. So:

```ts
export interface CoachPort {
  readonly coach: (request: CoachRequest) => Promise<CoachingResponse>;
}
```

It mirrors the library's own signature rather than inventing a new contract. That is deliberate: the
library `Coach` is today's only implementation, and a port that no implementation satisfies is a
worse abstraction than the class it replaced. The narrowing is real and is pinned — `CoachPort` is
**not** assignable to `Coach`, so it cannot quietly regrow the class's surface.

`Coach` satisfies it structurally, with no `implements` clause, no wrapper and no runtime cost.

### 2. `CoachService` does **not** satisfy this port, and is not made to

Checked, and the contracts differ in substance rather than in shape:

| | library `Coach` | API `CoachService` |
|---|---|---|
| signature | `coach(request)` | `coach(input, onAccepted?)` |
| sections | `T \| null` | `CoachSection<T> = CoachPresent<T> \| CoachOmitted` |
| puzzle | `Puzzle` — carries `solutionMove`, `comparisonMove` | `CoachPuzzleOutcome` — **no solution, by design** |
| provider data | `narrative`, `providerId`, `model`, `usage`, `latencyMs` | absent |

Three of those are not projections:

- **The puzzle solution.** `coach-service.ts` says it outright: "The solution is not here, and its
  absence is the point." An adapter returning a `CoachingResponse` would have to produce a
  `solutionMove` the service is designed never to send. That is fabrication, not mapping.
- **`CoachSection` → `T | null` loses the reason.** The wrapper distinguishes "not applicable" from
  "withheld" from "unavailable"; `null` cannot. Flattening it discards the withholding policy at the
  boundary that exists to carry it.
- **`onAccepted` is what charges the rate limit.** An adapter that dropped it would spend engine time
  for free.

So no adapter is written here. Requirement 6 of this task permits one only if it is "purely
structural/projection logic", and it is not.

### 3. The smallest adapter boundary, when something needs it

Recorded so the next increment does not rediscover it. A production Study Partner needs a
`CoachPort` implementation backed by `CoachService`, and it will need **three decisions, not three
mappings**:

1. **What a consumer sees when a section is withheld.** Either `CoachingResponse` grows a reason
   alongside each `null`, or the port stops returning `CoachingResponse` and returns a shape that
   carries availability — the second is cleaner and is a breaking change to this port.
2. **What the puzzle section means without a solution.** Study Partner reads
   `turn.coaching.puzzle?.kind === 'puzzle'` and counts a theme; that much survives a solution-free
   outcome. `VoiceCoach`, however, reads `solutionMove` and speaks it. A `CoachService`-backed port
   therefore cannot truthfully serve Voice Coach under the current contract; the production contract
   must preserve the withheld result and Voice Coach must verbalize only what that result exposes.
3. **Who charges.** `onAccepted` has no counterpart in the library contract, so the adapter's caller
   must supply it — which means the port, or its production variant, grows a second parameter.

Such an adapter belongs in `packages/api`, above this port. It must not live in `ai-features`, which
must not depend on `packages/api`.

## Alternatives considered

**Mirror the whole `Coach` API.** Rejected: it is the coupling being removed, wearing an interface's
name.

**Write the `CoachService` adapter now, mapping what maps and nulling the rest.** Rejected — this is
the dishonest abstraction the task names. It would compile, read as an enabling refactor, and quietly
answer "no tactic here" where the service meant "found one, withholding the answer".

**Put `CoachPort` in `packages/api`.** Rejected: the consumers live in `ai-features`, and importing a
port from `api` would invert the dependency direction.

## Consequences

`StudyPartner` and `VoiceCoach` depend on a behaviour rather than an implementation, and a fake that
is *only* a coach drives both end to end. Their observable behaviour is unchanged — the library
`Coach` still satisfies them, and the existing suites pass untouched.

**This does not make either feature production-ready, and nothing here should be read as saying so.**
It removes one of the blockers against Study Partner. The others — a durable `StudySessionStore`,
session ownership, routes, a migration — are untouched, as are Voice Coach's speech providers.

## Not fixed here

- **A `CoachService`-backed `CoachPort`.** Decision 3 above says what it would take. Not built,
  because it needs product decisions rather than code.
- **Study Partner and Voice Coach productionization** in every other respect: persistence, HTTP
  surface, UI, ownership, speech adapters, audio capture and storage.
