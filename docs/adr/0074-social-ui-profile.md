# ADR-0074 — Social UI on the Profile Page

| Field      | Value                                              |
|------------|----------------------------------------------------|
| **Status** | Accepted                                           |
| **Date**   | 2026-08-02                                         |
| **Scope**  | `@chess-platform/web`                              |

---

## Context

M10 shipped eight backend increments — social graph, messaging, teams and forums, achievements,
studies, courses, and a GraphQL read layer — totalling 91 endpoints. **None of them had any UI.**
The web app spoke four endpoint families (`/v1/auth`, `/v1/health`, `/v1/seeks`, `/v1/users`) across
four routes, so every M10 feature was reachable only with a REST client.

This is the first web increment of that track. It covers the social graph: the smallest coherent
surface (12 endpoints), and the one the others depend on — you find people before you message them
or team up with them. It extends the existing `/profile/:handle` route rather than adding a new one.

The surface is **Operate** (Impeccable v4): the visitor is completing a task, so scanability and
consistency outrank expression.

---

## Decisions

### 1. Reads through GraphQL, writes through REST — for a harder reason than round trips

ADR-0073 justified the read layer with fan-out. The binding reason here is narrower and stronger:

**The social endpoints return bare ids, and REST has no id-to-handle lookup.** `GET /v1/users/:handle`
resolves the other direction, and `GET /v1/social/friends` answers with UUIDs. So `player(id:)` in
the read layer is the *only* route from a follower id to a name a human can read. Without GraphQL
this page cannot name anybody.

Writes stay on REST because the read layer has no mutations by design (ADR-0073 §1).

### 2. A disabled read layer degrades the names, never the page

`GRAPHQL_ENABLED` is opt-in and the endpoint answers 503 when it is off. `GraphQLApi` therefore
converts every failure to `null` rather than throwing, and latches the answer so one request settles
it for the page instead of every list retrying a dead route.

When it is off the profile still loads: counts come from REST, actions work, and unresolved ids
render truncated (`01890000…`) under a note saying why. A feature flag being unset is a deployment
state, not a user error, and must not blank a page.

### 3. The relationship is derived, because the API cannot answer it

There is no "do I follow this player" endpoint. The twelve routes expose follows, requests and
blocks, but no relationship lookup. So the viewer's own following/blocks/requests are read once and
the relationship is derived from them, bounded by `RELATIONSHIP_SCAN_LIMIT` (100).

**This is knowingly approximate.** A viewer who follows more than 100 accounts can see "Follow" on
someone they already follow. That is safe rather than merely tolerated: `follow` is an idempotent
upsert and `unfollow` reports "nothing removed" without failing, so acting on a stale reading cannot
corrupt state. A relationship endpoint would remove the bound; until one exists, the honest
description is here rather than absent.

### 4. A write reloads instead of patching local state

Every action re-reads from the server. A follow can be refused by a block the viewer cannot see, and
a request can be accepted from the other side between render and click. Patching optimistically
would show an outcome the server did not agree to; the server's answer is the only one worth
rendering.

### 5. Sign-out clears the region, and an in-flight write must not undo that

The region holds one account's friends, pending requests and blocked players, so `clearSelfProfile`
empties it and resets the controller on sign-out.

That clear is only worth anything if nothing puts the data back. A write already in flight reloads
when it lands, so `act()` captures the generation before the write and abandons the reload if
`reset()` bumped it — otherwise signing out mid-action would repaint the very region the clear
exists to remove. Review caught this; the covering test performs a write, resets, and asserts
nothing was published.

The mirror of the same problem is the viewer *changing*: on another player's profile the relationship
is a function of who is looking, so a later sign-in or sign-out reloads the social region while the
profile above it stays put. Without that the controls are a snapshot of whoever was signed in when
the page rendered — working Follow/Block controls left visible after logout, or none at all after
login, until the visitor happened to navigate.

### 5b. Signing out clears the social region

The region holds one account's friends, pending requests and blocked players. Leaving it on screen
after sign-out would be a disclosure, not a stale render, so `clearSelfProfile` empties it and
resets the controller.

### 6. Visual decisions, and what they refuse

The incumbent world ("The Grandmaster's Study") is preserved, not extended:

- **One row treatment.** DESIGN.md requires every list in the app to look identical. `.rating-row`,
  `.game-row` and the new `.panel-row` were consolidated onto one shared rule rather than adding a
  third copy that could drift.
- **The row-action button is now documented, not invented.** Review flagged the compact in-row button
  as undocumented drift. It is neither new nor mine: `.seek-cancel` has shipped
  `font-size: 0.75rem; padding: 2px 10px` all along, and DESIGN.md's claim that "every button in the
  app uses this one style" was simply false. The two rules were merged and the variant written into
  DESIGN.md, so the document now describes the code. Removing the style instead would have made the
  social rows inconsistent with the seek list to satisfy a sentence that was wrong.
- **The destructive action is separated by distance, not by colour.** Review also asked for a primary
  CTA and de-emphasised secondary actions. That is declined as stated: DESIGN.md is explicit that
  there is no primary-button treatment and that "hierarchy comes from placement and copy, not a
  second button color", so adding one would break the system this increment is meant to preserve.
  The legitimate half — Block sitting flush against the connective actions, one mis-aimed click from
  severing a relationship — is addressed with placement, the mechanism DESIGN.md prescribes.
- **Counts sit beside their heading, not in tiles.** "Followers 12", not a metric card. The
  hero-metric/stat-grid template is the SaaS-dashboard look `PRODUCT.md` names as an anti-reference.
- **Follow state is carried by the verb** ("Follow" / "Unfollow"), never by colour. The system has
  exactly one accent and it means "active"; a colour difference here would be both off-system and
  invisible to a colourblind user.
- **A signed-out visitor gets an empty action bar, not disabled buttons.** Disabled controls
  advertise an affordance that is not available; absence is the honest state.
- No new radius, no second accent, no resting shadow, no badge wall.

---

## Consequences

- The read layer shipped in ADR-0073 now has its first consumer.
- The remaining M10 surfaces (teams, messaging, studies, courses, achievements) can follow the same
  shape: a feature API module, a DOM-free controller, and bootstrap wiring.
- `RELATIONSHIP_SCAN_LIMIT` is a real ceiling. A relationship endpoint is the fix, and it belongs to
  the backend, not to this layer.

## Known gaps, recorded rather than hidden

- **`Player` has no `teams` field.** ADR-0073's Context claims the motivating query is "a player with
  their followers, their *teams*, their achievements and their studies in one round trip", but the
  shipped schema exposes `followers`, `following`, `achievements` and `studies` only. Nothing here
  depends on it; it must be added — or the ADR corrected — when the teams surface lands.
- **Five pre-existing design-system findings in `src/style.css`** (`48px`, `2px`, `1.2rem`,
  `1.75rem`, `0.7rem`) are off the DESIGN.md ramps. All predate this increment and none are in this
  diff. They are reported rather than repaired, because fixing drift as a side effect of a feature
  is how a design-system change arrives unreviewed inside an unrelated PR.

## Verification

- `packages/web/test/social-controller.test.ts` — 17 tests. Ten rules were mutation-tested: each was
  broken in turn and the covering test confirmed to fail. The pass caught two tests that proved
  nothing, both for the same reason — a fake that could not reproduce the behaviour under test:
  1. The stale-load test returned identical data from both loads, so it passed with the generation
     guard removed. Rewritten with a gated slow response so the abandoned profile's reply lands last.
  2. The empty-profile test hard-coded `graphql.available`, so it could not distinguish "untried"
     from "reachable". The fake now latches the way `GraphQLApi` does: an empty id list issues no
     query and leaves the answer undecided.
- `packages/web/test/a11y.test.ts` — the six list regions, the alert role, and the viewer-only block
  starting hidden.
- Impeccable design detector over `index.html`, `style.css`, `bootstrap.ts`, `social-controller.ts`:
  no new findings.
- Web build, lint and 305/305 tests green.
