# ADR-0104 — The front door had no styles, and the board did not fit the window

| Field      | Value                                                              |
|------------|--------------------------------------------------------------------|
| **Status** | Accepted                                                           |
| **Date**   | 2026-08-07                                                         |
| **Scope**  | `packages/web` (`index.html`, `src/style.css`, `src/app/bootstrap.ts`) |

---

## Context

Found by running the platform and looking at it, not by a failing test. Each claim below was
observed on the running Compose stack before being fixed.

### 1. `class="auth"` matched no rule anywhere in the stylesheet

The sign-in surface — the first thing any new visitor sees — rendered as raw user-agent chrome
pinned to the top-left corner of the page: labels inline with inputs, default browser input
borders, no spacing, no container, no relationship to the lobby beneath it.

The cause was not drift or a bad rule. `packages/web/index.html` carried `class="auth"` and
`packages/web/src/style.css` contained **no `.auth` rule at all**. Every other surface in the app
— seeks, profile, teams, forum, messages, studies, learning — has a treatment described in
`DESIGN.md`. This one had a class name and nothing behind it.

Nothing caught it because nothing could: the markup was valid, the class names were spelled
correctly, the a11y suite passed, and the only evidence was on screen.

### 2. Pressing Enter did not sign you in

`<form id="auth-form" onsubmit="return false">` with **both** buttons `type="button"`, and no
handler bound to any key. Filling in a handle and password and pressing Enter did nothing at all,
with no message explaining why — on a form whose entire purpose is to be typed into. Signing in
required moving to the mouse.

Every other form in `bootstrap.ts` (the composer, the thread form, the team search, the site
search) already binds `onsubmit` and calls `preventDefault()`. This one was the exception.

### 3. The board grew taller than the window

`.cb-board` is `aspect-ratio: 1 / 1` with `width: 100%`, inside a grid column bounded only in
width. On a 1515×784 viewport it computed to ~810px tall against roughly 700px of available
height, so **rank 1 — the player's own back rank — sat below the fold** and you had to scroll to
see your own pieces during a live game.

### 4. Styling the section exposed a state defect behind it

With `.auth` finally visible, a signed-in visitor saw an empty panel headed "Sign in". The session
handler hid `#auth-form` and not the `#auth` section that carries the heading and the panel. The
bug predates this increment; it was invisible only because the section had no styling to see.

## Decisions

### 1. The surface joins the treatments that already exist

`.auth` gets the lobby's centred column at a form measure (360px), the `--panel` fill and the one
6px radius, matching `.empty` — the system's existing precedent for a single framed block. Labels
sit above their inputs in the `0.75rem` muted Label voice the clock's White/Black labels use.

The controls do **not** get new treatments:

- the inputs join the existing shared form-control selector list, beside `.nav-search input`
  and the create-game fields, rather than declaring their own padding, radius, fill and focus ring;
- `.auth h2` joins the existing `.lobby h2, .profile h2` rule rather than restating it;
- Sign in and Register are both the **default** button style. `DESIGN.md` has no primary-button
  variant, and hierarchy here comes from order and copy, exactly as the profile's action bar does
  it. One extra step of the spacing scale separates the actions from the fields.

The section also gains a visible `<h2>Sign in</h2>` and takes its accessible name from it via
`aria-labelledby`, replacing an `aria-label` only a screen reader could hear. Every other section
in the document already had a visible heading; this one is now consistent with them, and the
accessible name can no longer drift from the visible one.

### 2. `auth-submit` is a real submit button

`onsubmit="return false"` is removed from the markup, `auth-submit` becomes `type="submit"`, and
`bootstrap.ts` binds `authFormEl.onsubmit` with `preventDefault()` — the pattern the file's other
four forms already use. `auth-register` stays `type="button"`: it is the second action on a form
that has one default.

The click path and the Enter path now run the same code, so they cannot diverge.

### 3. The board takes the space that is left, and never estimates it

`body` becomes a flex column with `min-height: 100dvh` (after a `100vh` fallback), `.game` takes
`flex: 1` with `min-height: 0`, and `.cb-board` takes `height: 100%` with an automatic width.
`aspect-ratio` derives that width from the bounded height, while `max-width: 100%` can still shrink
both axes when width is tighter. Keeping width automatic is essential: a definite `width: 100%`
followed by `max-height: 100%` clamps only the height and distorts the board.

The first attempt did this with `max-width: min(100%, calc(100dvh - var(--board-chrome)))` and a
`--board-chrome: 96px` token measuring the topbar plus the grid's padding. The review of PR #101
found both ways that breaks, and they are worth recording because the token *looked* like the
careful version of the fix:

- `.topbar` carries `flex-wrap: wrap`. On a narrow window it becomes two rows, the real chrome
  exceeds 96px, and the board overflows again — on precisely the screens with the least room.
- On a very short viewport the subtraction goes negative. A negative `max-width` is invalid, so the
  declaration is dropped entirely and the cap disappears rather than tightening.

Both are the same underlying mistake: a number describing a layout, kept in a different place from
the layout. The flex version has no number, so there is nothing to keep in sync and nothing to
clamp. `min-height: 0` on `.game` is load-bearing — a flex item's default `min-height: auto`
refuses to shrink below its content, and without it the board's own size wins and the cap never
binds.

`style-contract.test.ts` asserts the absence of `calc(100dvh - …)` in the board rule, because
"let me just bump it to 120px" is exactly the edit this is here to prevent.

### 4. The section hides, not the form

`onSessionChange` now sets `hidden` on `#auth`. The section is the unit — it owns the heading and
the panel — and hiding its contents while leaving its frame is what produced the empty box.

### 5. What the tests pin

- `bootstrap.test.ts`: submitting the form calls the login endpoint, and an empty password sends
  nothing. The fake DOM grows a `FakeHTMLFormElement` with a dispatchable `onsubmit`, the same
  trick already used for `HTMLButtonElement`, because the form is now genuinely a form.
- `style-contract.test.ts`: every class the auth surface carries is matched by a rule **whose last
  compound names that class**, and the auth inputs appear in the shared form-control selector list.
  The first version of that test checked whether any selector mentioned the class, which `.auth h2`
  satisfies — deleting the entire `.auth` rule left it green. The narrowed version goes red.
- `a11y.test.ts`: the auth section is named by a visible heading. This replaces an assertion on the
  literal string `aria-label="Sign in"`, which the change would otherwise have simply broken. It is
  the stronger contract, not a relaxed one — it asserts the wiring rather than a spelling.

## Consequences

- The first screen a visitor sees is styled like the rest of the product.
- Enter signs you in.
- The whole board is on screen at laptop heights.
- A signed-in visitor sees no vestigial sign-in panel.
- A class in the markup with no rule behind it now fails a test instead of shipping.

## Out of scope

- Any change to authentication behaviour, endpoints, session handling, or copy beyond promoting the
  existing `aria-label` text to a visible heading.
- The three feature sections that answer 503 without their opt-in environment flags
  (`LEARNING_ENABLED`, `STUDIES_ENABLED`, `ACHIEVEMENTS_ENABLED`), and the nav that links to them
  regardless. Found in the same session; a separate increment.
- Registration as a distinct flow. Register remains the second button on the sign-in form.

## Verification note

The defects in §1–§4 were each observed on the running stack before being fixed, and the fixes are
confirmed present in the built bundle served by the web container (`.auth`, the shared form-control
list including `.auth-field input`, and the `.cb-board` height cap all appear in the shipped CSS).
The post-fix screenshot pass was not completed: the browser tooling disconnected partway through.
