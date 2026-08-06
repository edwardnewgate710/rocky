# ADR-0095 — Learner-scoped lesson step view

| Field      | Value                                                        |
|------------|--------------------------------------------------------------|
| **Status** | Accepted                                                     |
| **Date**   | 2026-08-06                                                   |
| **Scope**  | `packages/api`, `packages/web`                               |

---

## Context

`GET /v1/lessons/:id/steps` and `GET /v1/steps/:id` are public routes called by the web client (`packages/web/src/api/client.ts`, driven by `packages/web/src/app/learning-controller.ts`). Previously, both routes serialized steps through `stepView` (`packages/api/src/presenters.ts`), emitting:

- `expectedSan` on a `move` step (the correct move SAN), and
- `correctIndex` on a `quiz` step (the 0-indexed correct option).

This transmitted the answers to every lesson step on the wire to any caller, including unauthenticated learners and devtools users, before any attempt was made.

While `packages/web/src/api/models.ts` deliberately omitted `expectedSan` and `correctIndex` from the client-side TypeScript types so the web UI did not read or grade against them locally, the fields were still transmitted over HTTP.

Because nothing rated or rewarded depends on step progress today, this was a wart rather than a security breach, but needed resolving as tracked in `docs/ROADMAP.md`.

## Decisions

### 1. Caller-dependent projection (`LearnerStepView`) instead of deletion

Authoring routes (`POST /v1/lessons/:id/steps`, `PATCH /v1/steps/:id`, reorder, delete) legitimately require `expectedSan` and `correctIndex` in their responses so authors can inspect and edit step definitions. Deleting the fields from `StepView` would break authoring workflows.

Instead, we introduce `LearnerStepView` and `learnerStepView` in `packages/api/src/presenters.ts`. On the public read routes (`GET /v1/lessons/:id/steps` and `GET /v1/steps/:id`), if the authenticated caller is the author of the course the step belongs to, the response carries the full `StepView`. Otherwise (including anonymous callers and non-author authenticated learners), the response carries `LearnerStepView`.

### 2. Direct construction from domain model

`learnerStepView` builds its output object directly from the domain object `LessonStep` (`packages/learning/src/model.ts`), rather than delegating to `stepView` and deleting properties from the returned object. This ensures any future property added to `StepView` or `LessonStep` is not silently leaked to learners unless explicitly added to `LearnerStepView`.

### 3. The authorship decision is the API's; the course it needs comes from the read already made

Deciding what an actor may see is a concern of the API's contract, not something the domain repository should encode — so `packages/api/src/routes.ts` makes the comparison itself (`course.authorId === actorId`), and no permission concept enters `LearningRepository`.

Getting the course to compare against is a separate question, and the first attempt got it wrong. Resolving it with the existing `getLesson` + `getCourse` after the step read looked free at the API layer and was not: both reads had **already happened inside** `listSteps` / `getStep`, which resolve lesson → course to enforce invariant 1 and then discard the course. Counting SQL round-trips in `packages/persistence/src/pg/learning.ts` for an authenticated caller on `GET /v1/lessons/:id/steps`:

| | before ADR-0095 | first attempt | shipped |
|---|---|---|---|
| step read (`getLesson` → lessons + courses, then steps) | 3 | 3 | 3 |
| separate authorship lookup (`getLesson` → lessons + courses, then `getCourse` → courses) | — | 3 | — |
| **total** | **3** | **6** | **3** |

`GET /v1/steps/:id` is the same. The first attempt doubled both routes and read the courses table three times per request; it was caught in the review of PR #92, not by a test, because every response was correct throughout.

No reordering at the API layer avoids this — the duplication is *inside* the repository methods. So `LearningRepository` gained `getStepWithCourse` and `listStepsWithCourse`, which return the course the plain forms already loaded. Visibility, ordering and `not_found` behaviour are identical; `getStep` and `listSteps` now delegate to them, so there is one implementation of the rule rather than two. The course is returned as **data, not as a permission** — the repository still says nothing about who may see what, which keeps decision 3's boundary intact while removing the cost.

An unauthenticated caller is never the author, and `actorId === undefined` is checked before the comparison.

### 4. The added cost is zero, and a test holds it there

The public step routes make exactly one repository call each. `packages/api/test/learning-api.test.ts` wraps the repository in a counting proxy and asserts that call count for both an author and a learner, because this is invisible to every other kind of test: the responses were correct, and all shape and permission tests passed, while the query count was doubled. Re-introducing a second lookup fails that test rather than showing up as production latency.

### 5. Client model comment alignment

Comments in `packages/web/src/api/models.ts` on `MoveStepView` and `QuizStepView` were updated to reflect that `expectedSan` and `correctIndex` are no longer sent by the server to learners.

## Consequences

- Answers (`expectedSan` and `correctIndex`) are no longer sent over the wire on public step read routes to learners or anonymous callers.
- Course authors retain full step details on all routes, including public read endpoints.
- OpenAPI schema in `packages/api/src/openapi/schemas.ts` and `packages/api/openapi.json` accurately reflects `LearnerStepView` and `LearnerStepList` for public read routes.

## Out of Scope

- Client-side attempt grading remains server-authoritative (`POST /v1/steps/:id/attempt`).
- No changes to `packages/learning` domain or persistence packages.
- No changes to authoring routes or authoring UI workflows.
