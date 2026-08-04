---
name: Gambit
description: The world's most advanced online chess platform — competitive play, AI coaching, and premium user experience.
colors:
  ink: "#161512"
  paper: "#f7f6f5"
  ash: "#bababa"
  charcoal: "#2b2b2b"
  board-light: "#f0d9b5"
  board-dark: "#b58863"
  teal-accent: "#20b2aa"
  teal-accent-deep: "#17827c"
  selection-edge: "#161512"
  ember: "#e5484d"
  ember-deep: "#b42318"
  hint-green: "#14551e80"
  last-move: "#9bc70068"
  premove-blue: "#141ec866"
  panel-tint: "#ffffff0a"
  panel-tint-strong: "#ffffff0f"
  scrim: "#000000b8"
  promo-tile: "#fafafa"
  promo-tile-ink: "#111111"
typography:
  title:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.2
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.4
  small:
    fontFamily: "system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1
  numeric:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1
    fontFeature: "tabular-nums"
rounded:
  base: "6px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
components:
  button:
    backgroundColor: "transparent"
    textColor: "{colors.ash}"
    typography: "{typography.body}"
    rounded: "{rounded.base}"
    padding: "6px 14px"
  button-hover:
    backgroundColor: "{colors.panel-tint}"
    textColor: "{colors.ash}"
    rounded: "{rounded.base}"
  panel-row:
    backgroundColor: "{colors.panel-tint}"
    typography: "{typography.small}"
    rounded: "{rounded.base}"
    padding: "8px 12px"
  clock:
    backgroundColor: "{colors.panel-tint-strong}"
    typography: "{typography.numeric}"
    rounded: "{rounded.base}"
    padding: "8px 12px"
  board-square-light:
    backgroundColor: "{colors.board-light}"
  board-square-dark:
    backgroundColor: "{colors.board-dark}"
---

# Design System: Gambit

## 1. Overview

**Creative North Star: "The Grandmaster's Study"**

Gambit's UI reads like the desk of a serious player: warm dark wood and felt, one board lit at the center, nothing else competing for attention. The palette borrows the same board-square hues generations of players already trust (Lichess and Chess.com both start here), because reinventing the board would cost recognition for no gain — the differentiation is in restraint, not novelty. Chrome is minimal to the point of being nearly invisible: no shadows at rest, no card stacks, no gradient flourishes. The one saturated color in the system, a teal, exists solely to say "this is selected, this is active, this is focused" — it is never decorative.

This system explicitly rejects two aesthetics named in PRODUCT.md: the **generic SaaS dashboard** (cards everywhere, gradient heroes, tool-for-work chrome — Gambit is a game, not a B2B console) and the **cluttered, gamified chess site** (badge walls, streak counters, and noisy gamification competing with the board). Precision reads as premium here; decoration reads as noise.

**Key Characteristics:**
- Warm near-black by default (`#161512`), with a true light mode, not a tint of the dark palette
- Classic wood board coloring — familiar, not novel
- One accent color, one job: interactive/selected state
- Fully flat at rest; elevation appears only as a response to touch
- A single 6px radius used everywhere — no radius scale to keep track of
- System font stack only — clarity over typographic personality

## 2. Colors

The palette is deliberately narrow: two neutrals (dark-mode default, light-mode alternate), the two wood tones every player already recognizes, one accent, one danger color, and a small set of translucent overlays for board feedback and panel depth.

### Primary
- **Grandmaster Teal** (`#20b2aa`): the system's only accent. Used exclusively for selection outlines, the active player's clock, and focus rings. Never used decoratively, never repeated as a second "brand color" elsewhere on the page.

### Secondary
- **Board Light** (`#f0d9b5`) / **Board Dark** (`#b58863`): the two square tones. This exact pairing is the shared visual language of online chess (Lichess, Chess.com) — kept intentionally, not modernized, so the board reads as instantly legible to anyone who has played online before.

### Tertiary
- **Ember** (`#e5484d`, dark mode) / **Ember Deep** (`#b42318`, light mode): danger/error state — form validation errors, failed actions. Newly separated from Grandmaster Teal (previously the same teal covered both selection and error text, which meant "you're selected" and "something's wrong" shared one hue — a real problem for colorblind users, and confusing regardless). Ember is reserved for error/danger only and must never be used for a neutral interactive state.

### Neutral
- **Ink** (`#161512`): default (dark-mode) background — warm near-black, not pure black.
- **Paper** (`#f7f6f5`): light-mode background — a true off-white, not a tinted version of Ink.
- **Ash** (`#bababa`): body text on Ink.
- **Charcoal** (`#2b2b2b`): body text on Paper.
- **Panel Tint** (`#ffffff0a`) / **Panel Tint Strong** (`#ffffff0f`): translucent white overlays used to lift list rows (seeks, ratings, recent games) and the clock module a hair off the background, without a hard edge or a shadow.

### Board Feedback (functional, not decorative)
- **Hint Green** (`#14551e80`): legal-destination dot/ring on the board.
- **Last Move** (`#9bc70068`): highlights the two squares of the most recent move.
- **Premove Blue** (`#141ec866`): highlights a queued premove.

### Named Rules
**The Single Accent Rule.** Grandmaster Teal is the only saturated interactive color in the system. It is never used twice for two different meanings — error state gets Ember, board feedback gets its own dedicated hues. If a new state needs a color, it gets its own token; it does not borrow Teal.

## 3. Typography

**Body Font:** system-ui (with sans-serif fallback)
**Label/Numeric Font:** system-ui (same family, weight and feature-setting carry the distinction)

**Character:** One typeface, doing all the work through weight, size, and `font-variant-numeric: tabular-nums` rather than a second family. Nothing about this system is a typographic showcase — the board is the visual centerpiece, and type stays out of its way.

### Hierarchy
- **Title** (700, 1.25rem, 1.2 line-height): the wordmark and section headings (`Open seeks`, `Profile`). The largest text anywhere in the system — there is no display/hero scale.
- **Body** (400, 16px, 1.4 line-height): default running text, form labels, status messages.
- **Small** (400, 0.875rem, 1.4 line-height): list-row content — seek rows, rating rows, recent-game rows.
- **Label** (400, 0.75rem, 1 line-height, ~70% opacity): the tiny "White"/"Black" clock-side labels.
- **Numeric** (600, 1.5rem, 1 line-height, tabular-nums): clock time only. The one place weight and size step up, because misreading a clock under time pressure is the one typographic failure that actually costs a competitive player a game.

### Named Rules
**The No-Hero Rule.** There is no display-scale heading anywhere in the system. The board is the largest, highest-contrast element on every screen; type never competes with it for size.

## 4. Elevation

Flat at rest, everywhere. There is no `box-shadow` in the current implementation — depth on static layouts comes entirely from Panel Tint overlays (list rows, the clock module) and outline rings (selection, focus). Going forward, restrained elevation is introduced **only as a response to interaction** — hover and focus/active states on buttons and the promotion picker get a soft, low-spread shadow that resting elements never have. This keeps the "premium, tactile" feel confirmed for interactive components without letting shadows creep into the resting layout, which is exactly the SaaS-dashboard card look this system rejects.

### Shadow Vocabulary
- **Interactive Lift** (`box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28)`): applied only on `:hover`/`:focus-visible`/`:active` for buttons and the promotion-choice picker. Never applied to a resting element.

### Named Rules
**The Flat-at-Rest Rule.** No element carries a shadow in its default state. Shadows exist purely as interaction feedback — the instant the pointer or focus leaves, the shadow leaves with it.

## 5. Components

### Buttons
- **Shape:** 6px radius (`{rounded.base}`), same as every other rounded element in the system — there is no separate button radius scale.
- **Default:** transparent background, 1px border in the current text color (`currentColor`), `padding: 6px 14px`. Every standalone button in the app — sign in, register, create seek, flip board, theme toggle, sign out — uses this one style. There is no separate "primary button" treatment; hierarchy comes from placement and copy, not a second button color.
- **Row action** (`padding: 2px 10px`, `Label` typography): the compact form used *only* for a control that sits inside a list row — the seek-list cancel, and the accept/decline/cancel/unblock controls in the social lists. Identical shape, border, hover and focus treatment; padding and type step down so a control never out-weighs the row it belongs to. This is a size, not a second button style, and it is the only size variant that exists. A control outside a row uses the default.
- **Hover / Focus:** `Panel Tint` background fill plus **Interactive Lift** shadow on hover; a 3px Grandmaster Teal outline on `:focus-visible`. Both are additive to the flat default, never a permanent state.
- **Ghost / disabled:** disabled buttons (e.g. "Create seek" before sign-in) keep the same shape but drop to reduced opacity with a `title` tooltip explaining why — never hidden entirely.

### List Rows (seeks, ratings, recent games)
- **Shape:** `Panel Tint` background, 6px radius, `padding: 8px 12px` (seek rows) or `6px 12px` (rating/game rows), `Small` typography.
- **Behavior:** every list in the app — the seek list, the ratings list, the recent-games list — uses the identical row treatment. No card, no border, no per-list variation.

### The Board
- **Squares:** Board Light / Board Dark fills, no radius on individual squares; the 6px radius and `overflow: hidden` live on the board container only.
- **Selection:** a 3px inset two-tone ring — 1px `Selection Edge` (ink) on the outside, 2px Grandmaster Teal inside — still inset so it never shifts layout. The ink edge exists for contrast, not decoration: board squares are fixed by chess convention and theme-independent, and no teal clears the 3:1 WCAG 1.4.11 floor against *both* (Teal is 1.9:1 on Board Light and 1.2:1 on Board Dark; Teal Deep is 3.4:1 / 1.5:1). Ink clears both at 13.3:1 / 5.8:1, so it carries the contrast while the teal band keeps selection reading as teal. Don't drop the ink edge to "clean up" the ring.
- **Legal destinations:** Hint Green dot (empty square) or ring (capture) — shape difference is intentional and colorblind-relevant: a player who can't distinguish the hue can still distinguish dot vs. ring.
- **Last move / premove:** full-square translucent tint (Last Move / Premove Blue), applied as a pseudo-element so it never displaces the piece glyph.
- **Promotion picker:** a `Scrim` (`rgba(0,0,0,0.72)`) over the affected file, with square choice buttons on a near-white `Promo Tile` (`#fafafa`) fill — the one place the system intentionally breaks from Ink/Paper, because the picker needs to read clearly regardless of active theme. Because the tile is near-white in *both* themes, its focus ring uses **Grandmaster Teal Deep**, not the standard Teal (see Focus below).

### Clock
- **Style:** `Panel Tint Strong` background, 6px radius, `Numeric` typography, `padding: 8px 12px`.
- **Active state:** the side to move renders in Grandmaster Teal — the same accent as board selection, reinforcing "this is the thing that's live right now" as one consistent meaning across the whole screen.

### Navigation
- Plain text links (`Ash` color, 80% opacity, 100% on hover), no underline, no pill/tab background. Wordmark is `Title` typography and doubles as the home link.
- **Search field** (`.nav-search`): the one control that sits in the nav. It is not a nav-specific input style — it shares the single form-control treatment used by the create-a-game panel's select and number fields (`Panel Tint Strong` fill, transparent 1px border, the system's one 6px radius, `Small` type, teal focus ring, 44px minimum target on coarse pointers), and declares only its own width. A second input treatment here would be the same drift a second button style would be: the field is in a different place, not a different kind of control.

## 6. Do's and Don'ts

### Do:
- **Do** keep the board as the single largest, highest-contrast element on every screen — nothing else scales up to compete with it.
- **Do** use Grandmaster Teal for one meaning only: active/selected/focused. If a new feature needs a second accent, it needs its own token, not a Teal variant.
- **Do** switch to **Grandmaster Teal Deep** (`teal-accent-deep`) wherever the accent lands on a light surface — light theme, or the always-near-white promotion tile. Standard Teal measures only 2.4:1 on Paper and 2.5:1 on the promo tile, below the 3:1 WCAG 1.4.11 floor for focus and state indicators; Deep clears it at 4.3:1 / 4.5:1. This is a legibility variant of the *same* meaning, not a second accent — light mode remaps `--sel` to it automatically, so use `--sel` and it resolves correctly.
- **Do** keep every list (seeks, ratings, games, and any future list) on the identical `panel-row` treatment — one row style for the whole app.
- **Do** reserve shadows for interaction feedback only (`Interactive Lift` on hover/focus/active) — resting layouts stay flat.
- **Do** keep legal-move/last-move/premove board cues distinguishable by shape as well as color (dot vs. ring, full-square tint vs. outline) so they read without relying on hue alone.
- **Do** use Ember/Ember Deep for error and danger states exclusively — never reuse Teal for error text again.

### Don't:
- **Don't** build a generic SaaS-dashboard look — no card grids, no gradient hero banners, no tool-for-work chrome. This is a game, not a B2B console.
- **Don't** add gamification clutter — no badge walls, streak counters, or achievement noise competing with the board or the game state.
- **Don't** introduce a second accent color "for variety." One saturated interactive color is the point, not a limitation.
- **Don't** add a resting-state shadow to any card, panel, or list row — shadows only ever respond to interaction.
- **Don't** introduce a new border-radius value. Everything rounded in this system uses the same 6px — a second radius reads as inconsistency, not craft.
- **Don't** reuse the dark-mode `Panel Tint` (a white overlay) unmodified in light mode — a white-on-near-white overlay is close to invisible on `Paper`. Light-mode panel treatment needs its own dark-tinted overlay. This is now handled by the `--panel` / `--panel-strong` tokens, which resolve to a white overlay on Ink and an ink-tinted dark overlay on Paper; use those tokens rather than a raw `rgba(255,255,255,…)` fill.
