# Design Brief: Create-a-Game Flow

> Produced with `/impeccable shape`. Status: **confirmed** (direction locked;
> color selection kept in scope but sequenced behind an API change — see §10 /
> Color sequencing). Scope: design brief only — no code written yet.

## 1. Feature Summary

A first-class way for a signed-in player to post a game offer ("seek") with the
settings they actually want — time control, casual/rated, variant, and optional
rating range — instead of today's single hard-coded "standard · 5+0 · casual"
button. It lives on the lobby, feeds the existing seek list, and must feel as
fast and frictionless as Lichess's create-a-game panel.

## 2. Primary User Action

**Pick a time control and post the seek in as few clicks as possible.**
Everything else (rated, variant, rating range) is secondary and should stay out
of the way until wanted. The 90% path is: open → tap a preset → Create.

## 3. Design Direction

- **Color strategy:** Restrained (PRODUCT.md / DESIGN.md default). One accent —
  Grandmaster Teal — carries exactly one meaning: *selected* (the chosen preset
  chip, the active toggle segment, focus rings). No second accent for "rated."
- **Scene sentence:** *A rated player, mid-session at their desk, wants a 5+3
  blitz game now and doesn't want a settings dialog standing between them and
  the board.* → forces a lightweight inline panel, not a modal, and inherits the
  existing light/dark themes.
- **Anchor references:** Lichess "Create a game" panel (preset grid +
  casual/rated + optional rating range) as the primary model; the compactness of
  Raycast's inline forms for the progressive-disclosure discipline. Explicitly
  *not* Chess.com's busier new-game modal.

## 4. Scope

Brief only — a production-ready spec to hand to `/impeccable craft` or build
later. Breadth: one self-contained flow on the lobby route. Interactivity when
built: shipped-quality inline component with full states.

## 5. Layout Strategy

Inline **disclosure panel** on the lobby, replacing the lone "Create seek"
button, sitting above the seek list:

- **Collapsed (default):** a single "Create seek" trigger (today's affordance,
  preserved).
- **Expanded:** a `--panel`-tinted block, 6px radius, flat at rest.
  - Top row = **time-preset chip grid** (`flex-wrap`, wraps cleanly on mobile).
  - Below = **Casual / Rated** segmented toggle.
  - Below that = a **"More options"** disclosure holding Variant and Rating
    range (collapsed by default — Standard / Any).
  - Primary **Create seek** button anchors the bottom.
- The board is never covered; the panel pushes the list down, no overlay.
  Hierarchy: presets are the loudest element, mode toggle second, advanced
  options visually quiet until opened.

## 6. Key States

- **Collapsed (default, signed in):** just the trigger.
- **Expanded / default selection:** a sensible preset preselected (e.g. 10+0),
  Casual, Standard, Any rating.
- **Not signed in:** trigger disabled with the existing "Sign in to create a
  seek" tooltip; panel doesn't open. (Already wired.)
- **Custom time:** a "Custom" chip reveals initial-minutes + increment-seconds
  inputs; live-derives the speed-bucket label.
- **Pending:** Create button → "Creating…", disabled, controls locked (uses the
  existing `onCreatePending` callback).
- **Error:** surfaced in the existing lobby `.error` element (Ember) — e.g. auth
  or validation failures.
- **Success:** panel collapses, the new seek appears in the list as *your* seek
  with the Cancel button; a quiet "Waiting for an opponent…" line on that row.
- **Edge:** very long variant names, rating-range `min > max` guard, and the
  already-handled empty seek list.

## 7. Interaction Model

Open → focus lands on the preset grid. Arrow/tab through chips; a chip selects on
click/Enter (teal outline = selected). Casual/Rated is a two-segment toggle.
"More options" expands Variant (the 8-variant set) and a Rating-range control
(default "Any"). Create posts the seek → pending → success collapses the panel
and the seek drops into the list. Esc or a "Cancel" text button collapses
without posting. All transitions 150–200ms; reduced-motion collapses to instant.

## 8. Content Requirements

- **Presets:** `1+0  2+1  3+0  3+2  5+0  5+3  10+0  10+5  15+10  30+20  Custom`,
  each mapping to a valid `TimeControl` (`sudden_death` when increment 0, else
  `increment`); each shows its derived speed tag (Bullet / Blitz / Rapid /
  Classical).
- **Mode:** "Casual" / "Rated" (+ one muted line: "Rated games affect your
  rating.").
- **Variant:** human-readable labels for the 8 contract variants — Standard,
  Chess960, King of the Hill, Atomic, Crazyhouse, Three-check, Horde, Racing
  Kings.
- **Rating range:** "Any rating" default → optional min/max (`minRating` /
  `maxRating`, which the contract already supports).
- **Button:** "Create seek" (keep the existing noun). Errors surfaced from the
  API verbatim / mapped.

## 9. Recommended References (for implementation)

`layout.md` (chip grid + disclosure rhythm), `interaction-design.md` (segmented
toggle, form states, keyboard flow), `clarify.md` (preset / mode / variant
microcopy), and a `polish.md` pass before ship.

## 10. Open Questions & Decisions

1. **Color preference — confirmed in scope, sequenced behind the API.** See
   "Color sequencing" below.
2. **Multiple simultaneous seeks:** post-success state assumes one active seek
   shown with Cancel; if the server allows several, the list already handles it.
   Default: "server decides," no special UI.
3. Everything else is asserted defaults (inline not modal, 10+0 preselected,
   advanced options collapsed, rating-range included-but-quiet).

## Color sequencing (build order)

Color selection (White / Random / Black) is **kept in scope** but cannot ship
from the frontend alone — the `CreateSeekRequest` contract in
`packages/web/src/api/models.ts` has no color field, and the server's pairing
logic must honor it.

1. **Contract + server (backend, first):** add
   `color?: 'white' | 'black' | 'random'` (default `'random'`) to
   `CreateSeekRequest` and the seek record; have matchmaking assign sides
   accordingly (creator's choice; `random` = server coin-flip at pairing).
   Mirror it in the OpenAPI spec (`packages/api/openapi.json`) and in `SeekView`
   if the chosen color should be visible on the seek row.
2. **Frontend (this flow):** add a third control to the panel — a **Color
   segmented toggle: White / Random / Black** — using the same segmented pattern
   as Casual/Rated, teal outline = selected, **default Random**. It slots
   between the Mode toggle and "More options," so the common path stays:
   preset → Create. Pass `color` through `LobbyController.createSeek` →
   `CreateSeekRequest`.

Until step 1 lands, the frontend can't post a color, so the toggle would be
non-functional — hence building it the moment the contract ships, not before.

## Data-model grounding

The brief is grounded in the real M4 contract (`packages/web/src/api/models.ts`):

- `CreateSeekRequest` today supports: `variant` (8 variants), `timeControl`
  (`{ initialMs, incrementMs, delayMs, kind: 'increment' | 'delay' |
  'sudden_death' | 'unlimited' }`), `rated?`, `minRating?`, `maxRating?`.
- `speed` is **derived server-side** — the form does not send it.
- No `color` field yet (see Color sequencing).
