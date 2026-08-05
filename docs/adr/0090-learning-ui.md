# ADR-0090 — Learner-facing Learning UI (courses, lessons, steps)

| Field      | Value                                                  |
|------------|--------------------------------------------------------|
| **Status** | Accepted                                               |
| **Date**   | 2026-08-05                                             |
| **Scope**  | `packages/web`, `packages/e2e-harness`                 |

---

## Context

The `@chess-platform/learning` package and 23 API routes under `/v1/courses`, `/v1/lessons`, `/v1/steps` have existed since Milestone 10 with no UI. This increment builds the learner's half of the subsystem: browsing published courses, viewing course lessons, and working through lesson steps.

Building this UI required resolving how move steps, multi-step lesson pages, navigation, per-step progress persistence, and service unavailability (503) degrade within the restraint of `packages/web`'s design system (`packages/web/DESIGN.md`).

## Decisions

### 1. Move steps use text SAN input and a read-only board with region landmark

Legal moves in a live game arrive over the WebSocket via `AuthoritativeMoveOracle`, and `packages/web` has no client-side rules engine (`packages/web/src/core/mover.ts`). No API route evaluates legal moves for an arbitrary FEN outside a live game.

Therefore, move steps render the position FEN on a board mounted with `setTurn(false)`, which is read-only in the sense that matters: `BoardInteraction` returns `{ kind: 'none' }` for every gesture and offers no legal destinations, so no move can be produced and none is submitted. It is not inert to the touch — `select()` is not gated by `myTurn` (`packages/web/src/core/interaction.ts`), so a click still places a selection ring on the square. That is honest (the square *is* selected) but useless here; suppressing it would mean a `readOnly` mode in the shared board, which this increment does not open. The board container receives `role="region"` with `aria-label="Chess board position for Step X (read-only)"` and a visually-hidden text paragraph describing the FEN. The learner enters their answer as SAN (e.g. `Nf3`) into a text input, which is POSTed to `POST /v1/steps/:id/attempt` for server-side evaluation.

### 2. All steps of a lesson render on one scrolling page separated by hairline rules

Rather than a multi-step wizard with prev/next chrome or card stacks, all steps in a lesson render on a single scrolling page in `orderIndex` order. Steps are separated by vertical spacing and a subtle hairline rule (`border-bottom: 1px solid var(--panel-strong)`), maintaining flat layout without card backgrounds (`--panel` fill), card stacks, or extra radii. Each step manages its own completed state and answer controls independently.

### 3. Navigation adds `Learn` as a plain-text nav entry

A sixth nav link, `Learn` (`/courses`), is added to the topbar navigation in `packages/web/index.html`. It receives the exact same treatment as the existing five links — plain text link (`Ash` color), no pill, no tab, no background.

### 4. Correct/incorrect states use words in the muted voice, not secondary accents

`packages/web/DESIGN.md` enforces the Single Accent Rule: Grandmaster Teal (`--sel`) means active/selected/focused ONLY. Ember (`--ember`) is reserved for errors and danger states. A wrong answer in a lesson is a normal state, not a system error or danger fault.

To respect the design system without inventing a second accent or overloading Ember, step attempts present feedback strictly in words (`Done`, `Try again`) using the muted `.count` voice (`#8f8f8c`).

### 5. `StepView` omits answer fields from client-side models

`StepView` in `packages/web/src/api/models.ts` is modeled as a discriminated union (`TextStepView | MoveStepView | QuizStepView`) on `kind`. Server wire answer fields (`expectedSan` and `correctIndex`) are deliberately omitted from the client-side TypeScript interfaces. This makes rendering answers or evaluating attempts locally a compile-time type error — grading is performed strictly server-side via `POST /v1/steps/:id/attempt`.

### 6. Per-step progress details seed step attempts on load and survive page reloads

When authenticated, `LearningController.loadLesson` fetches course progress details via `GET /v1/courses/:id/progress/details` alongside steps. Per-step attempt states are derived via `deriveStepAttempts(progressDetails)` (`completedAt` -> `Done`, `attempts > 0` -> `Try again`). This populates step attempt states on initial paint and ensures per-step completion persists across page reloads.

### 7. Unavailable service (503) degrades quietly with a plain sentence

When `learningRepository` is absent on the API server, every learning endpoint returns 503. Handled identically to achievements (ADR-0089): GET requests pass `permanentStatuses: [503]` to suppress retries, and `LearningController` latches on `ServiceUnavailableError`.

The latch's reach is narrower than it looks, and ADR-0089 overstated it. `bootstrap` re-runs on every SPA navigation (`packages/web/src/main.ts` — "`run()` re-bootstraps in place"), and every section controller is constructed inside it, so navigating to a new route builds a **new** controller with a fresh latch that asks again. The latch therefore suppresses repeat calls *within one view* — on the lesson page it stops an attempt submission after the reads have already 503'd — not across a browsing session. The saving that actually scales is `permanentStatuses: [503]`, which takes each view from `maxAttempts` requests per endpoint down to one.

Because `/courses` is a top-level nav destination, quiet degradation displays a single quiet sentence (`Learning service unavailable.`) in the muted `.count` voice rather than a loud error banner or an empty screen.

### 8. E2E harness reuses `CorePositionReader` and exposes `POST /e2e/courses` bridge route

`InMemoryLearningRepository` is wired as `learningRepository` in `packages/e2e-harness` using `CorePositionReader` exported from `@chess-platform/api`. A test-only bridge route `POST /e2e/courses` seeds a published course with one lesson and three steps (`text`, `move`, `quiz`) using the repository's real domain methods so validation and ordering follow production rules. Malformed requests answer 400.

## Consequences

- Learners can browse published courses (`/courses`), view lessons (`/courses/:slug`), and complete steps (`/lessons/:id`).
- Per-step completion state persists across page reloads, because the lesson seeds per-step state from `GET /v1/courses/:id/progress/details`. Without it the page contradicted itself after a reload: the summary read `1 / 3 steps completed` while every step showed no status, since in-session attempts were the only source. The e2e spec reloads and re-asserts, which is what holds this.
- A move step's board can still be clicked into a selection ring even though it accepts no moves (§1). Cosmetic, and the cost of not opening a `readOnly` mode in the shared board.
- The learner never receives a gradeable answer in a shape the client can use: `expectedSan` and `correctIndex` are on the wire but off the client types (§5). They remain readable in devtools — the server still sends them, and a learner-scoped step view is tracked as a follow-up in `docs/ROADMAP.md`, not fixed here.

## Alternatives considered

- **Interactive move dragging on step board:** Rejected because `packages/web` has no client-side rules engine, and no API endpoint returns legal move lists for arbitrary step FENs.
- **One-step-at-a-time wizard with prev/next buttons:** Rejected in favor of a single scrolling page displaying all steps of a lesson.
- **Color-coded correct/incorrect badges:** Rejected under the Single Accent Rule and anti-gamification guidelines.
