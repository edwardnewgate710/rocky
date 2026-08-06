# ADR-0097 — Delete `AttemptResult.message` rather than populate it

| Field      | Value                                        |
|------------|----------------------------------------------|
| **Status** | Accepted                                     |
| **Date**   | 2026-08-06                                   |
| **Scope**  | `packages/learning`, `packages/api`          |

---

## Context

`AttemptResult` in `packages/learning/src/model.ts` carried `readonly message?: string`, and
`attemptResultView` in `packages/api/src/presenters.ts` did not map it. `docs/ROADMAP.md` tracked
that as a presenter dropping a domain field, in the same family as the `ForumPostView` divergence
fixed by ADR-0088 and the `JoinRequestView` one fixed in M14 increment 28.

It is not the same defect. Those two were real divergences: the server produced a value and the
contract disagreed about it. Here **nothing has ever produced a value.** The declaration at
`model.ts:83` was the only occurrence of the field in the repository — `submitAttempt` in
`packages/learning/src/in-memory-repository.ts` never set it, neither did the Postgres adapter in
`packages/persistence/src/pg/learning.ts`, and no client modelled it. The presenter was dropping
nothing.

## Decisions

### 1. Delete the field

The two available resolutions were to populate it or to remove it. Populating means writing the
wording of a feedback feature that has never existed — what a learner is told when they answer
wrongly is a product decision, not a gap to close while tidying a contract. Removing a field no
implementation sets is the "no speculative anything" case exactly: it advertised a capability the
system does not have, and every reader who found it had to re-derive that it was dead.

Deleting is also the reversible direction. The domain can regain the field on the day something
actually produces a message, and at that point the value and its wording arrive together.

### 2. What a learner is actually told, stated plainly

This ADR should not leave the impression that attempt feedback is covered. It is not, evenly:

- a **move** step can carry a `hint`, written by the course author, and that reaches the learner
  today — a real explanation channel, unaffected by this change;
- a **quiz** step has no author-written explanation field at all;
- since ADR-0095 the learner's step view omits `expectedSan` and `correctIndex`, so a learner cannot
  derive the answer from the payload either.

So a wrong quiz answer yields `Try again` and nothing else. That is a genuine product gap, and it is
the gap this deletion makes visible rather than one it creates. Closing it means designing the
feedback, not restoring an unused optional field.

### 3. Pin the contract that remains

`AttemptResultView` was the last presenter in `packages/api/src/presenters.ts` with no
schema/presenter coupling test, and this project has now found that divergence three times
(ADR-0088, M14 increments 28 and 30) — each time surviving because every route test reads the
response and none read the schema. `packages/api/test/openapi.test.ts` now asserts the served schema
against the presenter's real output.

The assertion differs from its neighbours in one way worth recording: `completedAt` is genuinely
optional on both sides, so the declared properties are checked against the union of both branches
while `required` is checked against the always-present keys. Asserting one list against the other,
as the `JoinRequestView` test does, would fail on a correct contract here.

## Consequences

- `AttemptResult` has four fields, all of which every implementation sets.
- Re-introducing a `message` on the schema without a presenter that emits it now fails a test.
- The wire contract is unchanged: `attemptResultView` emitted no `message` before this change and
  emits none after it. No client needs updating.

## Out of scope

- Designing learner feedback for a wrong attempt, which is the real gap named in §2.
- Any change to `hint`, to the learner step view, or to ADR-0095.
