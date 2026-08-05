# ADR-0094 — Search hits carry their own display metadata

| Field      | Value                                                        |
|------------|--------------------------------------------------------------|
| **Status** | Accepted                                                     |
| **Date**   | 2026-08-05                                                   |
| **Scope**  | `packages/search`, `packages/api`, `packages/web`            |

---

## Context

`GET /v1/search` returned `{ id, score }` and nothing else, so the Search UI resolved every row through a second call. For a page of ten (`search-controller.ts`):

- 1 search request, then
- up to **10** per-result entity fetches (`tournaments.byId`, `games.byId`), then
- 1 batched `graphql.resolvePlayers`

**Up to 12 requests per query.** Worse than the count: rows only painted once *every* hydration settled, so one slow tournament fetch delayed the whole list, and a failed fetch degraded that row to a bare truncated id.

ADR-0083 §2 recorded the gap and the three mitigations already in place — page size 10, parallel fetches, a single batched player resolve. Those bounded the cost; they did not remove it. Tracked as a follow-up in `docs/ROADMAP.md` since increment 19.

## Decisions

### 1. Display metadata is its own field, not `fields` and not `text`

`SearchableDocument` gains `display?: { type, title, subtitle? }` alongside the existing `text` and `fields`.

It cannot live in either of the existing two:

- **`fields`** is documented as "exact-match filterable fields" and every projection canonicalizes its values to lowercase. A title stored there comes back as `kasparov vs deepblue`, and a filter map that also holds prose stops being a filter map.
- **`text`** is the match corpus — a concatenation tuned for recall (`whiteHandle blackHandle eco variant speed`). It is built to be *matched*, not read.

`display` is `?` optional rather than required, because a document indexed before this field existed still matches and must still be returned. The UI degrades such a hit to a labelled, linkless row rather than dropping a real result.

### 2. Entity type was already indexed; it needed surfacing, not inventing

Every projection has always written `fields.type` as `game` / `player` / `tournament`. The web client was re-deriving the same fact by string-splitting the namespaced id in `parseSearchHit`. `display.type` now carries it explicitly; `parseSearchHit` remains because the **id** still has to be split for the href.

### 3. Titles are built only from data the entity's public view already exposes

`packages/search/src/projections.ts` carries an explicit security note: **`email`, `email_hash` and `flags` are NEVER indexed**, and a player document indexes strictly `handle` and optional `country`.

`display` introduces no new source. It reuses fields the projection already had:

| entity | title | subtitle |
|---|---|---|
| player | `handle` | `country` when present |
| game | `White vs Black` | `variant · speed · result` |
| tournament | `name` | `format · state` |

A test asserts the serialized player document contains no `email`, `hash`, `flag` or `@` — the constraint is checked, not merely restated. A game title degrades to whichever side is present rather than rendering `" vs "`.

### 4. The loading placeholder is removed, not restyled

`bootstrap.ts` used to write `<div class="panel-row">Loading…</div>` into the results list — a counterfeit result, announced by a screen reader as a row. It existed to cover the window while hydration filled in. That window is now a single round trip, so the fake row costs more than it buys. `aria-busy` on `#search-results`, already wired, carries the state alone.

Found by the Impeccable audit of this surface (P1), run before the increment.

### 5. `.tournament-link` becomes `.row-link`

The class was applied to forum threads, message conversations, team rows, member rows and search results — six call sites, of which one was a tournament. The name described the first consumer, not the thing.

Renamed across all call sites and in `packages/web/DESIGN.md`. This is the same correction, for the same reason, that ADR-0089 §7 made when `.team-row-main` became `.row-main`: a shared primitive named after one caller invites a second, per-entity variant.

## Consequences

- A search page costs **one request** instead of up to twelve, and paints in one pass. Pinned by a controller test whose fake client throws if `tournaments.byId`, `games.byId` or `resolvePlayers` is touched — a request count, not a rendered string, because rendering looks identical either way.
- A per-row failure mode disappears: there is no per-result fetch left to fail.
- The search row gains a subtitle and therefore joins the `.row-main` composition rule as its fourth consumer. `.panel-row` is `space-between` and takes exactly two children; the subtitle travels *inside* the leading half with its title, never as a third child.
- The OpenAPI schema declares `display` as optional. Declaring it required would repeat the `ForumPostView` defect (ADR-0088) and the still-open `JoinRequestView` one: a spec promising a field the server cannot always send.
- Documents indexed before this change carry no `display` until reindexed. Nothing breaks; those rows show a truncated id and no link.

## Alternatives considered

- **Put title/subtitle in `fields`.** Rejected in §1 — casing is destroyed and the map's meaning is overloaded.
- **Keep hydration but widen the batch** (one bulk endpoint for mixed entity ids). Still two round trips, still a second failure mode, and it needs a new endpoint whose only caller is this list.
- **Have the client format the subtitle from `fields`.** The fields are lowercase, so the client would be title-casing values the server already had in the right form — and every client would have to agree on the formatting.
