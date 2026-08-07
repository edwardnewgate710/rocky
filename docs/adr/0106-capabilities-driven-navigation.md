# ADR-0106 — Capabilities-driven navigation

| Field      | Value                                                              |
|------------|--------------------------------------------------------------------|
| **Status** | Accepted                                                           |
| **Date**   | 2026-08-07                                                         |
| **Scope**  | `packages/api` (`routes.ts`, `schemas.ts`), `packages/web` (`index.html`, `src/app/capabilities-nav.ts`, `src/api/client.ts`, `src/api/models.ts`) |

---

## Context

Three features in the application (`/v1/courses`, `/v1/studies`, `/v1/achievements`) are gated behind opt-in environment flags (`LEARNING_ENABLED`, `STUDIES_ENABLED`, `ACHIEVEMENTS_ENABLED`). In standard deployments where these optional subsystems are not configured, requests to these endpoints respond with HTTP 503 Service Unavailable:

- `GET /v1/courses` → `503 {"error":{"code":"service_unavailable","message":"learning repository is not configured"}}`
- `GET /v1/studies` → `503`
- `GET /v1/achievements` → `503`

However, top-level navigation links in `packages/web/index.html` advertised "Learn" and "Studies" regardless of whether the subsystem was configured. Clicking "Learn" produced a bare sentence ("Learning service unavailable.") — a door that opened onto a wall.

`packages/web/DESIGN.md` establishes a consistent rule regarding feature availability across three separate sections:
- Line 201 (Teams): *"An explanation is the state; a disabled button that can never enable is not."*
- Line 210 (Forum): *"A disabled composer that can never enable is worse than an explanation."*
- Line 219 (Achievements): *"The section hides itself when the deployment has no achievements service … A load that fails for one profile does show its error, because that one a visitor can retry."*

The core axis is **retryability**, not severity:
- **Cannot possibly succeed in this deployment** → withdraw the affordance.
- **Failed this time, or for this viewer** → explain it, because they can act.

A 503 from an unconfigured subsystem is of the first kind: it can never succeed in the current deployment. Therefore, the nav links must be removed when the underlying subsystem is unavailable, while keeping the existing quiet sentence for anyone who arrives directly via URL or bookmark.

## Decisions

### 1. Backend: `GET /v1/capabilities` endpoint

- Added `GET /v1/capabilities` in `packages/api/src/routes.ts` under the `meta` tag (public, unauthenticated).
- Capabilities are derived strictly from `deps` (e.g. `deps.learningRepository !== undefined`), **never from `process.env`**. `bootstrap.ts` is the single source of truth for constructing repositories. Reading `process.env` inside route handlers would duplicate configuration and break tests/e2e harness which inject repositories directly without setting environment variables.
- Response shape: a fixed set of booleans covering every optional service gated by bootstrap:
  ```json
  {
    "capabilities": {
      "learning": false,
      "studies": false,
      "achievements": false,
      "search": true,
      "social": true,
      "messaging": true,
      "community": true
    }
  }
  ```
- Component schema `Capabilities` added in `packages/api/src/openapi/schemas.ts` and pinned against presenter output in `packages/api/test/openapi.test.ts` to prevent schema/presenter drift.

### 2. Frontend: Capabilities-driven navigation

On bootstrap, `GambitClient.capabilities()` is called once, and the links whose capability is
`false` are removed from the DOM. `packages/web/src/app/capabilities-nav.ts` holds the one mapping
from `data-route` to capability key.

**The links ship visible and are removed — not hidden and revealed.** This was written the other
way first, on the reasoning that a control vanishing under the pointer reads as a bug and that
DESIGN.md's "Trust through polish" therefore rules it out. That reasoning has the cost backwards.
Revealing on confirmation leaves *every* link the deployment does have missing until a network
round-trip completes — on every page load, for every visitor — in order to spare a moment's flicker
on links that lead nowhere and are being deleted anyway. The rare case does not get to tax the
common one.

It also deletes a branch rather than adding one. There is no fail-open policy to implement: if the
request fails or answers with a body that has no `capabilities` key, the function returns and the
visitor keeps the navigation they already had. A network blip cannot amputate the app, because
nothing was ever waiting on the network in order to appear.

### 3. Only an explicit `false` removes a link

The response body is cast, not validated — the same property that required a guard in ADR-0103 — so
its shape is a claim rather than a fact, and this is the trust boundary. Two attempts got it wrong
before the rule was stated this plainly, and both are worth recording because each looked correct:

- Checking only for `null` missed `undefined`: a 200 whose body has no `capabilities` key threw
  `Cannot read properties of undefined` inside bootstrap's async chain, over a navigation tidy-up.
- Accepting any object and then reading each flag for *truthiness* meant a 200 carrying
  `{"capabilities": {}}` read as "every capability is off" and stripped the entire optional
  navigation — failing closed, silently, on a malformed response. Raised in the review of PR #102.

So the rule is not "reject bad payloads", which invites arguing about what counts as bad. It is
that **removal requires a positive `false`**. A missing key, a non-boolean value, an empty object, a
null, a body that is not an object, a failed request — all mean "not answered", and an unanswered
question must never cost the visitor a link. The decision lives in a pure `routesToRemove(payload)`
so every one of those cases is tested without touching the network.

### 4. Fetched once per page, not once per navigation

`main.ts` re-runs `bootstrap(document)` on **every SPA navigation and every `popstate`**, not once
per page load. The capabilities promise is therefore memoised for the page's lifetime; without it
the app asks for its capabilities again on every in-app click, to redo a DOM pass whose answer
cannot have changed.

This memo was briefly removed during review of the delegated work, on the reading that bootstrap
runs once — a claim about `main.ts` made without opening it. The review of PR #102 caught the
regression. There is deliberately no reset export to accompany the memo: the decision cases are
tested through the pure function above, and the one test that exercises the fetch asserts the
memoisation in the same test, so production code does not grow a seam whose only purpose is letting
a test rewind it.

## Consequences

- Navigation dynamically reflects deployment capabilities without hardcoded lists or disabled "Coming soon" placeholders.
- Schema-presenter coupling tests ensure `Capabilities` wire contracts remain in sync.
- Fail-open strategy guarantees application robustness against transient network errors.

## Out of scope

- Modifying the 503 response handlers or messages.
- Enabling optional flags in `docker-compose.yml`.
- Modifying achievements section's existing 503 handling in Profile.
- Any UI redesign or restyling.
- Adding npm dependencies.
