# ADR-0081 — Play vs Computer Lobby UI

| Field      | Value               |
|------------|---------------------|
| **Status** | Accepted            |
| **Date**   | 2026-08-03          |
| **Scope**  | `packages/web`      |

---

## Context

M14 increment 13 (ADR-0080) introduced the backend API endpoint `POST /v1/games/bot` for playing games against Stockfish engine bots (`gambit-novice`, `gambit-club`, `gambit-master`). However, there was no user interface in the browser lobby allowing players to configure and launch a game against the computer.

Adding a UI for computer games requires addressing four design decisions:
1. **Modal Overlay vs. Inline Form**: How the computer game controls are surfaced relative to the adjacent seek creation panel.
2. **Variant Restrictions**: Which chess variants are offered in the computer game selection.
3. **Rating Expectation Management**: Clear communication that games against the computer do not mutate human ratings.
4. **Testing and Verification Boundaries**: Accounting for package testing conventions and CI environments without a Stockfish binary.

## Decision

### 1. Native `<dialog>` Modal Interface

The computer game launcher is implemented as a native `<dialog>` element (`PlayBotDialog` in `packages/web/src/app/play-bot-dialog.ts`).

A native `<dialog>` invoked via `showModal()` is chosen over an inline collapsible panel (used by `CreateGamePanel` in `packages/web/src/app/create-game-panel.ts`) for several key reasons:
- **Built-in Focus Trapping & Backdrop**: Native `<dialog>` provides focus trapping, background inerting, and backdrop rendering (`.pb-dialog::backdrop` in `packages/web/src/style.css`) out-of-the-box without requiring third-party libraries or hand-rolled event listeners.
- **Escape-to-Close**: Native `<dialog>` handles keydown Escape closing natively; `PlayBotDialog` wires `close` event listeners to clean up internal state.
- **Modal Isolation**: Errors during bot game creation surface directly inside the modal error region (`<p class="cg-field-error" role="alert">`) rather than behind the modal backdrop on the lobby error element (`#lobby-error` in `packages/web/index.html`).

### 2. Standard Variant Hardcoding

Although `POST /v1/games/bot` accepts any `Variant` enum value, `packages/web/src/app/bootstrap.ts` hardcodes `variant: 'standard'` when calling `lobby.createBotGame(...)`.

This decision reflects backend engine capabilities: the Stockfish engine worker binary is built for standard chess rules and does not support alternative variants such as Atomic or Crazyhouse. Offering unplayable variants in the UI would be a false promise.

### 3. Clear Unrated Game Indication

The dialog contains an explicit note stating that games against the computer are unrated. Because the API forcibly overrides any request to `rated: false` (ADR-0080), the UI refrains from offering a rated/casual toggle and informs the player up front.

### 4. Selection Vocabulary and Shared DOM Helper

To prevent styling fragmentation across the lobby UI, `PlayBotDialog` reuses the established selection vocabulary (`.cg-chip`, `.cg-seg`, `.cg-field`, `.cg-segmented`, `.cg-hint`, `.cg-field-error` in `packages/web/src/style.css`) and custom CSS properties (`--panel`, `--panel-strong`, `--muted`, `--sel`, `--ember`).

Element construction uses `el()` extracted into a shared pure utility module (`packages/web/src/app/dom.ts`) consumed by both `CreateGamePanel` and `PlayBotDialog`. Pure bot level options and parsing logic are encapsulated in `packages/web/src/app/bot-levels.ts`.

### 5. The Trigger Uses the Default Button, Not `.cg-trigger`

The first version of this increment gave the new trigger the same `.cg-trigger` class as the lobby's
"Create a game" button, on the reasoning that DESIGN.md defines one button style and derives hierarchy
from placement and copy rather than from a second treatment.

That reasoning was incomplete. `.cg-trigger` is not the default: it adds `font-weight: 600` and
`padding: 8px 16px` on top of the base button's `6px 14px`, so it *is* an emphasis treatment — one
DESIGN.md never documents. Applying it to a second button put two equally loud calls to action on the
same surface, which is the outcome the "no separate primary treatment" rule exists to prevent.

The new trigger therefore uses the base button style, and hierarchy comes from placement (below the
seek builder) and copy — exactly the mechanism DESIGN.md specifies. `.cg-trigger` remains on the
single emphasised lobby action.

### 6. What Is NOT Covered

- **DOM Unit Tests**: Following package conventions where complex DOM components (such as `CreateGamePanel`) are not unit-tested, DOM components rely on Playwright E2E coverage (`packages/web/e2e/play-vs-computer.spec.ts`) and static HTML accessibility checks (`packages/web/test/a11y.test.ts`). Pure modules are unit-tested in `packages/web/test/bot-levels.test.ts` and `packages/web/test/api-client.test.ts`.
- **Real-Engine Execution in CI**: CI environments do not ship a Stockfish binary (ADR-0080). E2E specs gating on `GAMBIT_E2E_BACKEND` run against the e2e test harness.

## Consequences

- Logged-in users can open the "Play vs Computer" dialog from the lobby (`packages/web/index.html`), select a difficulty level (`novice`, `club`, `master`), side (`white`, `random`, `black`), and time control preset (`10+0`, `5+3`, etc.), and start a game.
- Typed client `GamesApi` in `packages/web/src/api/client.ts` exports `createVsBot(body: CreateBotGameRequest)`.
- `LobbyController` in `packages/web/src/app/lobby-controller.ts` exports `createBotGame(params)` gated on authentication.
- Verification via `npm run build`, `npm run lint`, `npm test`, and `npm run check:adr-claims` passes cleanly.
