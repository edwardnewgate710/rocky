# ADR-0101 — The promotion picker rendered blank tiles, and the design-system drift around it

| Field      | Value                    |
|------------|--------------------------|
| **Status** | Accepted                 |
| **Date**   | 2026-08-06               |
| **Scope**  | `packages/web`           |

---

## Context

A design pass over `packages/web/src/style.css` began as token-compliance work: the Impeccable
detector reported five advisory violations of `packages/web/DESIGN.md`'s own rules — a second
border-radius value and four font sizes off the documented ramp.

One of those five turned out not to be a token problem at all.

`.cb-promo-choice` carried `font-size: clamp(24px, 9vw, 48px)` on a button that has **no text
content**. Following that thread found the real defect: the promotion dialog was rendering four
identical blank tiles.

Each choice is a `<button>` carrying both `.cb-promo-choice` and the shared `.cb-p-*` class, and
`.cb-p-*` supplies only a `background-image`. `.cb-promo-choice` then set
`background: var(--promo-tile)` — the **shorthand**, which resets `background-image` to `none`. Both
selectors have specificity (0,1,0), and `.cb-promo-choice` appears later in the file, so the
shorthand won.

Verified rather than reasoned, by extracting the two rules verbatim into a page and reading the
computed style:

```
as shipped  background-image: none
with the image preserved  background-image: url("…/wQ.svg")
```

A player promoting a pawn saw four blank near-white squares, distinguishable only by tab order and
the `aria-label` on each button.

The dead `font-size` explains the history: the picker once drew Unicode characters, and when the
board moved to the Cburnett SVG set the shorthand silently erased the new artwork while the
now-meaningless `font-size` stayed behind. So did `color: var(--promo-tile-ink)` and its token.

## Decisions

### 1. `background-color`, never the shorthand, and the sizing belongs on the tile

`.cb-promo-choice` and its `:hover` now set `background-color`. The tile also declares
`background-size: contain`, `background-repeat: no-repeat` and `background-position: center`:
`.cb-piece` carries those for pieces on the board, and this button is not a `.cb-piece`, so without
them the SVG would render at intrinsic size, anchored top-left, and tiled.

The dead `font-size`, the dead `color`, and the now-unused `--promo-tile-ink` token are removed. They
are one fossil, not three.

### 2. The same bug existed a second time, on hover

Found in the review of PR #98, after the fix above had been written.

`button:not(:disabled):hover` set `background: var(--panel)`. That selector matches a promotion
choice — it is a `<button>` — and its specificity is **(0,2,1)**: one element, plus `:hover`, plus the
`:disabled` inside `:not()`. `.cb-p-*` is (0,1,0). So the generic rule outranked the artwork outright
and the piece vanished the moment the pointer touched a tile.

The comment directly above it already stated the intent — "Promotion choices carry their own
near-white fill; keep it on hover" — and a `.cb-promo-choice:hover` rule existed to do it. Neither
helped, because the damage was done by a higher-specificity rule that ran first and reset a property
the later rule never restored.

Both generic rules now use `background-color`. The base `button { background: transparent }` is
changed too: `.cb-p-*` at (0,1,0) does outrank `button` at (0,0,1), so the artwork survived at rest,
but surviving on a specificity margin is luck rather than design.

### 3. The contract is asserted against every rule that can match the element

`packages/web/test/style-contract.test.ts` asserts that **no rule whose selector can match a
promotion tile** uses the `background` shorthand, and that the tile declares `background-color` and
its sizing trio.

The first version of this test checked `.cb-promo-choice` and `.cb-promo-choice:hover` by name, and
missed the hover bug completely — it inspected the rules whose names were known instead of every rule
that reaches the element. That is the same mistake in test form as the bug itself: reasoning about
the declarations written in one place rather than about what actually applies to the element.

Testing CSS by reading it is unusual and deserves its reason: **nothing else could have caught
either instance.** The markup was right, the classes were right, the DOM was right, every test
passed, and the only evidence was on screen. Collapsing several `background-*` declarations into one
shorthand also looks like a tidy-up, which is what makes it the likeliest regression here.

Mutation-verified against both: restoring the shorthand on `.cb-promo-choice` fails, and restoring it
on `button:not(:disabled):hover` fails.

### 4. The near-white tile is correct, and was nearly "fixed" by mistake

Once the pieces rendered, the obvious next worry was white pieces on a near-white tile. Rendering
both colours showed the worry was unfounded: the Cburnett set draws a white queen as white **with a
heavy black outline**, not as a pale silhouette, so both colours read cleanly on `#fafafa`.

The token comment claimed the tile worked because "the piece glyphs are dark". That was true of the
Unicode characters and false of the SVG set — the right conclusion resting on a stale reason.
Corrected in place, since a comment that justifies a good decision badly invites someone to undo it.

### 5. The four token violations, fixed onto the documented ramp

`border-radius: 2px` on the nav focus ring became `6px`; `1.2rem` on `#theme-toggle` became `1.25rem`;
`1.75rem` on `.empty-mark` became `1.5rem`; `0.7rem` on `.cg-chip-speed` became `0.75rem`.

Three of those are near-misses of a documented step, and near-misses are the ones worth fixing in a
system built on restraint: `1.2` against a `1.25` ramp reads as inattention rather than intent, and
DESIGN.md states the single-radius rule in as many words. The detector reports zero findings after.

## Consequences

- The promotion dialog shows the piece you are choosing, in the same artwork it will have on the
  board a moment later.
- `packages/web/DESIGN.md` gains a Promotion picker component entry recording the shorthand rule,
  where the sizing lives, and why the tile is near-white.
- The stylesheet is back on its own type ramp and radius, with the detector clean.

## Out of scope

- Any change to the promotion flow, its keyboard handling, or its `aria-label`s.
- The `.cb-promo-cancel` control, which has text content and was unaffected.
