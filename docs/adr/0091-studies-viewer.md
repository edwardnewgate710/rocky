# ADR-0091 — Viewer-facing Studies UI (browse, chapters, move tree)

| Field      | Value                                                  |
|------------|--------------------------------------------------------|
| **Status** | Accepted                                               |
| **Date**   | 2026-08-05                                             |
| **Scope**  | `packages/web`, `packages/e2e-harness`                 |

---

## Context

The `@chess-platform/studies` package and 21 API routes under `/v1/studies` have existed since Milestone 10 with no UI. This increment builds the viewer's half of the subsystem: browsing public/collaborative studies, viewing study chapter lists, and analyzing chapter move trees.

Building this UI required resolving how move trees, indented variations, NAG annotations, board position updates, navigation, and service unavailability (503) degrade within the restraint of `packages/web`'s design system (`packages/web/DESIGN.md`).

## Decisions

### 1. Move tree renders as a notation pane with indented variations

Mainline moves flow as inline wrapping text, numbered in standard chess notation (`1. e4 e5 2. Nf3 Nc6`). Variations open indented blocks, one step per nesting level, with no bullets or list markers. This follows chess convention over the platform's standard list row idiom, extending the argument `DESIGN.md` makes for maintaining classic board square colors. Moves are not rendered as one per `.panel-row`.

### 2. Mainline typography retains normal weight without bold emphasis

`packages/web/DESIGN.md` reserves `font-weight: 600` strictly for the clock's `Numeric` role. The mainline is distinguished from variations by indentation, layout structure, and muted text colors rather than bold font weight.

### 3. Move selection uses Grandmaster Teal (`--sel`) exclusively

Under the Single Accent Rule, Grandmaster Teal (`--sel`) signifies active, selected, or focused states. Selecting a move in the notation pane highlights the move button using `--sel`, maintaining a single consistent meaning for the accent across the entire platform.

### 4. Moves are accessible focusable buttons with 44px coarse pointer touch targets

Every move in the tree is rendered as a focusable `<button type="button" class="notation-move">` with an accessible `aria-label` describing full move details (`Move 2 White Nf3!`). On coarse pointers (`@media (pointer: coarse)`), move targets expand to a minimum 44px hit area to avoid a dense grid of tiny unclickable touch targets.

### 5. NAGs fuse to move glyphs; positional assessment NAGs outside 1–6 render as nothing

PGN NAG codes 1–6 map to standard annotation suffixes: `1 → !`, `2 → ?`, `3 → !!`, `4 → ??`, `5 → !?`, `6 → ?!`. A mapped NAG fuses directly to its move (`Bb5!`). Positional assessment NAGs outside 1–6 (such as `$10`, `$14`, `$16`) render as empty strings, as their typographic glyphs (e.g. `⩲`/`∓`) have unestablished rendering in system font stacks. Comments follow moves as inline prose in the muted `.count` voice (`#8f8f8c`).

### 6. Moves set board position via stored `fenAfter`

`TreeNode` carries `fenAfter`. Because `packages/web` has no client-side rules engine, selecting a node sets the board position via `board.setPosition(node.fenAfter)`. When no node is selected, the board displays the chapter's `startingFen`.

### 7. Unavailable service (503) degrades quietly with a plain sentence

When `studiesRepository` is absent on the API server, every studies route returns 503. Handled identically to learning and achievements: GET requests pass `permanentStatuses: [503]` to suppress retries, and `StudiesController` latches on `ServiceUnavailableError`. Quiet degradation displays a single sentence (`Studies service unavailable.`) in muted text voice.

### 8. `main.ts` disposes controller on SPA navigation

`StudiesController` exposes a `dispose()` method. `main.ts` tracks `previous.studies` and disposes it on route re-bootstrapping, preventing in-flight requests or timers from leaking into hidden DOM elements across SPA navigation.

### 9. E2E harness wires `studiesRepository` and exposes `POST /e2e/studies`

`InMemoryStudiesRepository` is wired as `studiesRepository` in `packages/e2e-harness` using `CorePositionReader` from `@chess-platform/api`. The test bridge `POST /e2e/studies` seeds a public study with one chapter containing a mainline of at least four moves, one variation, one comment, and a NAG in the 1–6 range.

### 10. Mainline move takes `orderIndex 0` over variations during PGN import

`exportPgn` and move tree readers assume `children[0]` is the mainline. During PGN import, `buildTreeFromMovetext` in `@chess-platform/studies` previously appended variations before the move itself, assigning index 0 to variations and inverting mainline/variation lines on export or render. Appending the move before its variations ensures the mainline receives `orderIndex 0` while variations hang off the parent position before the move with `orderIndex >= 1`, preserving PGN tree structure across round-trips.

Reproduced with no UI involved — import then export through `InMemoryStudiesRepository`:

```
in:  1. e4 e5 2. Nf3 Nc6 (2... Nf6 3. Nxe5 d6) 3. Bb5 *
out: 1. e4 e5 2. Nf3 Nf6 (2... Nc6 3. Bb5)    3. Nxe5 d6 *
```

**The Postgres adapter already had this right.** `packages/persistence/src/pg/studies.ts` carries a comment describing this exact defect — *"every import carrying a `(...)` came back with its mainline and its sidelines swapped. Nothing errored; the game was simply a different game."* It was found and fixed there and never fixed in the in-memory adapter, so the two silently diverged. That is the part worth remembering: `InMemoryStudiesRepository` backs every unit test, the API fakes and the e2e harness, so **every test in the repo encoded the wrong behaviour while the production path did something else**. `chapterNameFor`'s docstring in `packages/studies/src/import.ts` warns about exactly this — logic written out twice in two adapters is "a difference waiting to appear" — and here it had already appeared, undetected, because no round-trip test existed outside the Postgres-gated integration suite.

Found by this increment's e2e move-count assertions. The earlier `toBeVisible()` assertions could not have: a swapped mainline still renders every move somewhere on the page.

## Consequences

- Visitors can browse public and collaborative studies (`/studies`), view study details (`/studies/:id`), and analyze chapter move trees (`/studies/:id/chapters/:chapterId`).
- PGN export is exposed via download links using `/v1/studies/:id/export.pgn`.
- The notation pane provides full keyboard accessibility and touch target sizing while maintaining strict visual alignment with `DESIGN.md`.

## Alternatives considered

- **Rendering each move as a `.panel-row`:** Rejected in favor of inline wrapping notation text with indented variation blocks, matching chess reader conventions.
- **Bold text for mainline moves:** Rejected under the typography hierarchy rule reserving 600 weight for clock numeric text.
- **Fallback rendering of raw NAG numbers (e.g. `$10`):** Rejected to avoid cluttering move text with numeric codes.
