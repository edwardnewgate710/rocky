# ADR-0089 — Achievements UI, and where the anti-gamification rule actually falls

| Field      | Value                                                  |
|------------|--------------------------------------------------------|
| **Status** | Accepted                                               |
| **Date**   | 2026-08-05                                             |
| **Scope**  | `packages/web`, `packages/e2e-harness`                 |

---

## Context

Milestone 10 increment 5 (ADR-0070) shipped the achievements subsystem — a 14-entry catalogue, an award worker, and 3 read routes — with no UI. Nothing in the app has ever shown a player an achievement.

The feature arrives with a conflict the other UI increments did not have. `packages/web/DESIGN.md` and `PRODUCT.md` both name the "cluttered, gamified chess site (badge walls, streak counters, and noisy gamification)" as an explicit anti-reference, and DESIGN.md's Don't list forbids it in as many words. An achievements section is, on its face, exactly the thing the design system was written to keep out.

Resolving that is the substance of this increment; the plumbing is ordinary.

## Decision

### 1. The rule forbids a badge wall, not achievements — and the line is now written down

The prohibition is about **treatment**, not subject matter: tiles, medals, tier colours, trophy iconography and progress bars competing for attention. A list of rows is not a wall.

So the section renders as the single List Row treatment every other list in the app uses — `.panel-row` inside `.panel-list`, exactly as ratings, recent games, followers, seeks, teams and forum threads do. It adds no colour, no icon, no radius and no accent. Concretely:

- **Tier is a word, not a colour.** `bronze`/`silver`/`gold` sit in the muted `.count` voice. Rendering them as three metal colours would add a second, third and fourth accent to a system that has exactly one, and would encode meaning in hue alone — which the same document forbids for board cues.
- **There is no progress bar.** A hairline fill was considered and rejected: it is the most recognisably gamified element in the set, and it is a visual primitive the system has no rule for. `7 / 10` carries the same fact in the voice the system already speaks.
- **An unlocked row says `Unlocked`, not `10 / 10`.** A finished count reads as a task still in hand.

The Don't in DESIGN.md now carries the qualification and points at the component section, so the next reader does not conclude the section violates the rule it was designed around. That is the durable output here: the rule was ambiguous enough that a reasonable implementer could have built a badge wall or refused to build anything, and both would have cited the same sentence.

### 2. `unlockedAt` is the only authority on whether something is unlocked

`PlayerAchievementView` carries both `progress` and `unlockedAt`, and the award worker writes them together. The UI never derives one from the other.

They can disagree. A catalogue `target` lowered after progress was stored leaves rows at or above their target with no unlock granted, and the reverse — an unlock granted while progress sits below a raised target — is equally reachable. Deriving the badge from the numbers would claim an award the server never made. `progressLabel` reads `unlockedAt` and nothing else.

### 3. An absent `target` counts to one, because that is what the domain does

`target` is optional in the published contract and absent for every one-shot achievement (`first-game`, `first-win`, `speed-demon`, …). `resolveAward` in `packages/achievements/src/award.ts` reads `definition.target ?? 1`. The UI reads it the same way rather than inventing a second answer; anything else renders those rows as `0 / undefined`. A non-positive target collapses to the same reading rather than dividing the row by zero.

Displayed progress is clamped into `[0, target]` on the way out. The writer clamps on award, but the read contract does not promise it, so the clamp belongs on both sides.

### 4. The section removes itself when the deployment has no achievements service

The award worker is opt-in behind `ACHIEVEMENTS_ENABLED` (`services/gateway/src/serve.ts`), and without the repository every achievements route answers **503**. That is a deployment configuration, not a fault, and it is identical on every profile — so a 503 hides the section rather than painting an error the visitor can do nothing about. A failure that is *not* 503 does show, because that one is worth retrying.

This is the same posture the GraphQL read layer already takes when its flag is off (ADR-0073): degrade quietly, do not shout.

Two details follow from 503 being a *deployment setting* rather than a fault, both added in review:

- **It is not retried.** 503 is classified transient by the transport (`RETRYABLE_STATUS` in `packages/web/src/net/errors.ts`), so each of the two endpoints was attempted `maxAttempts` times — six requests to be told the same permanent thing. The two calls now pass `permanentStatuses: [503]`, a new `RequestSpec` field that overrides the transient classification for named statuses only.
- **It is asked once per view.** The controller also latches on the first 503. *Corrected while building Increment 23:* this section originally claimed the latch holds "for the rest of the page session", and it does not. `bootstrap` re-runs on every SPA navigation (`packages/web/src/main.ts`), constructing a new `AchievementsController` with a fresh latch, so the next profile asks again. Since a profile view triggers exactly one load, the latch almost never fires here — the saving that actually scales is `permanentStatuses: [503]` above, which takes a view from six requests to two. The latch is cheap and correct, but it is not what does the work.
- **`ServiceUnavailableError` now exists.** 503 previously arrived as a plain `ServerError`, so the only way to recognise it was to sniff `status` off an untyped `Error` — which the errors module explicitly tells callers not to do, and which misreads any foreign error that happens to carry a `status`. 503 is now its own subclass of `ServerError`, so the branch is `instanceof` like every other branch in the taxonomy, and an existing 5xx branch still catches it.

`permanentStatuses` exists rather than `idempotent: false` — the narrower knob rather than the one already on the type — because `idempotent: false` suppresses retries for *every* failure class. These endpoints would then stop recovering from a network blip or a 502, painting an error on the profile where today the second attempt succeeds silently. That is a user-visible regression traded for four requests, and the retry policy's own docstring already says the transport classification is a hint the policy has final say over. Naming the status keeps 503 fast and leaves genuine transients retrying.

### 5. The catalogue route is not exposed to the client

`GET /v1/achievements` exists and is not used. `GET /v1/players/:id/achievements` already returns every visible definition joined with this player's progress, so a second call would add nothing the app renders. No pagination argument either: 14 entries against a server default page of 50 means one page always suffices, and a page control today would be a lever with nothing on the end of it.

### 6. The harness gets the repository and a bridge route that awards through the real rule

`InMemoryAchievementsRepository` is now wired as `achievementsRepository` — the sixth optional `ApiDependencies` field the harness has needed, after messaging, social, search, community and GraphQL.

Awarding in production is driven by `AchievementsAwardWorker` reacting to `games:ended` and reading finished games from Postgres. That worker is not wired into the harness, so an e2e spec would otherwise have to play a full game to move one counter. `POST /e2e/achievements` calls the repository's real `award()` — the same method the worker calls — so progress and unlock timing follow the production rules rather than a fixture that hardcodes them. Namespaced under `/e2e/` like `POST /e2e/games` and `POST /e2e/search-index` so it never reaches the product API surface. An unknown key or fractional increment answers 400, not 500: that is a broken fixture, not a harness fault.

### 7. `.team-row-main` is renamed to `.row-main`

The class is a generic "leading half of a row" primitive — flex, baseline-aligned, `min-width: 0`, with an ellipsising `.count` child. It was already shared by teams and forum rows; achievements is its third consumer and has nothing to do with teams. Renamed at all four call sites and in DESIGN.md.

## Consequences

- Achievements are visible for the first time, on a player's own profile and on anyone else's — the routes are public and keyed by player id.
- The design system now states where the anti-gamification line falls, which is the part most likely to be re-litigated.
- One new CSS rule exists: `.achievement-standing` (`flex-shrink: 0`, `white-space: nowrap`). Measured at 320px, the trailing `bronze · 0 / 50` wrapped to three lines and took the row from 32px to 51px, because it is several words where teams and forum rows trail with one. A teams row with a comparably long name measures the same 51px, so multi-line rows at that width are incumbent behaviour, not a regression this increment introduced.
- Nothing awards achievements in the e2e environment except the bridge route, so the specs prove rendering and wiring, not the award worker. The worker has its own unit tests (`packages/api/test/achievements-award-worker.test.ts`).

## Alternatives considered

- **A summary line only** (`Achievements: 7 of 13 · 250 points`, no list). Maximally faithful to the anti-gamification rule and the smallest possible surface, but it renders an entire subsystem as one sentence and gives a player no way to see what exists or how close they are.
- **Tier as colour.** Rejected under the Single Accent Rule; it would need three new tokens and would carry meaning in hue alone.
- **A dedicated `/achievements` route.** Rejected: a sixth nav entry for a read-only surface, separated from the profile it describes.
- **Deriving the unlocked state from `progress >= target`,** dropping `unlockedAt` from the render path. Rejected in §2; it is wrong in both directions and the mutation test for it fails as expected.
