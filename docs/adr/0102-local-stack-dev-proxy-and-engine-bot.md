# ADR-0102 — The dev server had no API proxy, and the bot had no engine

| Field      | Value                                                              |
|------------|--------------------------------------------------------------------|
| **Status** | Accepted                                                           |
| **Date**   | 2026-08-06                                                         |
| **Scope**  | `packages/web`, `packages/engine`, `Dockerfile.gateway`, `docker-compose.yml` |

---

## Context

Two defects reported from running the platform locally: registering an account answered `HTTP 404`,
and the computer opponent in **Play vs Computer** never moved. They are unrelated in cause and are
recorded together because they were found together.

Each claim below was reproduced before being fixed.

### 1. `npm run dev` served an app whose every API call 404'd

`resolveEndpoints` in `packages/web/src/app/config.ts` derives the API origin from
`location.origin`. That is right in production, where nginx proxies `/v1` to the API, and right under
`vite preview`, whose config already carried a proxy for the e2e harness.

`vite dev` had no `server.proxy` at all. So the app posted to `http://localhost:5173/v1/auth/register`
— a path the dev server does not serve — and Vite answered 404. The symptom reads as a broken
backend; the cause is a missing two-line proxy.

### 2. "Play vs Computer" could not have worked in Compose

`services/gateway/src/serve.ts:460` builds an `EngineBotMover` only when `ENGINE_BOT === '1'` **and**
an engine binary exists at `STOCKFISH_PATH`. Neither held:

- `docker-compose.yml` never set `ENGINE_BOT` on the gateway service;
- `Dockerfile.gateway` installed no engine.

The failure is silent by design — the gateway logs a warning and continues — so the lobby kept
offering the mode with an opponent that never moved.

### 3. And underneath that, the engine refused the platform's own variant name

Enabling the bot exposes a second, independent bug, reproduced as a unit test before any fix:

```
NoEngineForVariantError: No registered engine supports variant "standard".
```

`@chess-platform/core` calls ordinary chess **`standard`**, and that is what
`services/gateway/src/engine-bot.ts:174` passes. UCI engines call it **`chess`**, and that is what
Stockfish reports in its discovered capabilities.

`stockfishPlugin.variantSetup` already accepted `standard` — the engine could always play the game.
Only the routing said otherwise:

- `expectedVariants` listed `['chess', 'chess960']`, so the **cold** path rejected `standard`;
- `EnginePool.supportsVariant` consulted *only* discovered capabilities once warm, and those carry
  the UCI name, so the **warm** path rejected it too.

Every existing test in `packages/engine/test/manager.test.ts` routed with `variant: 'chess'` — the
engine's vocabulary, never the platform's. That is why a suite of 50 passing tests never caught a
bug that made every bot game fail.

## Decisions

### 1. The dev server proxies what preview proxies

`packages/web/vite.config.ts` gains a `server.proxy` for `/v1` and `/ws`, defaulting to the Compose
ports (`8080`, `4175`) and overridable with `GAMBIT_DEV_API_URL` / `GAMBIT_DEV_WS_URL`.

The alternative — "run `docker compose up` and use port 3000 instead" — is a usage instruction, not a
fix. `npm run dev` is the ordinary way to work on the UI, and it should reach a backend rather than
serve an app that 404s on its first request.

### 2. Routing translates the name; it does not widen the check

The first attempt at this made `supportsVariant` return the union of discovered capabilities and
`expectedVariants`. That fixed `standard` and introduced a worse bug, caught in the review of PR #99:
a warm pool would then claim any variant its plugin *expected*, even one the engine had explicitly
not reported. A Stockfish build without `UCI_Chess960` would be routed Chess960 over a Fairy-Stockfish
that could actually play it, and fail at play time instead of at routing time.

Capabilities must stay authoritative. What was actually needed is a translation, not a widening:
`EnginePlugin` gains an optional `engineVariantName(variant)`, and `supportsVariant` asks the
capabilities under both the platform's name and the engine's.

- Stockfish maps `standard` → `chess`.
- Fairy-Stockfish returns `FAIRY_VARIANT_NAMES[variant]`, the map it already used for
  `variantSetup` — so the translation lives in one place rather than being duplicated.

Feeding Fairy from that map exposed a third instance the report did not mention and the union fix
would have masked: the platform says `threecheck` and a warm Fairy reports `3check`, so that variant
had the identical warm-path failure. Both plugins keep `expectedVariants` in the engine's vocabulary,
used only before warmup when nothing has been discovered.

### 3. The gateway image ships an engine, and Compose enables the bot

`Dockerfile.gateway` installs Stockfish and sets `STOCKFISH_PATH=/usr/games/stockfish`;

> **Correction (M15 Increment 12).** That path was Debian's, from the `apt-get install stockfish`
> this ADR described. The image now takes a pinned Stockfish 16 from an artefact stage and sets
> `STOCKFISH_PATH=/usr/local/bin/stockfish`. The decision recorded here — that the gateway image
> ships an engine and Compose enables the bot — is unchanged; only where the binary comes from and
> where it lands. See [ADR-0121](0121-deterministic-engine-install-in-ci.md).

`docker-compose.yml` sets `ENGINE_BOT: ${ENGINE_BOT:-1}` on the gateway, overridable to `0`.

`docs/RUNNING.md` records both requirements and the log line that confirms them
(`EngineBotMover is enabled`), because the failure mode is a warning rather than a crash.

### 4. Tests pin the vocabulary gap and the proxy parity

- `packages/engine/test/manager.test.ts` routes `standard` both warm and cold. Both tests fail with
  `NoEngineForVariantError` against the unfixed code — verified before the fix, not asserted after.
- `packages/web/test/dev-proxy.test.ts` **imports the resolved config** and asserts `server` and
  `preview` proxy the same paths, that each marks `/ws` with `ws: true`, and that every proxied path
  has a target. Nothing tested `vite.config.ts` at all, which is how one server had a proxy and the
  other did not.

  Its first version read the file as text and searched it with hard-coded indentation, quote style
  and a hand-rolled brace counter — so reformatting or a CRLF checkout could fail CI while the proxy
  was correct, and a broken proxy written in another style could pass. Also raised in the review of
  PR #99. Importing the config asserts what Vite will actually use; verified by rewriting the `/ws`
  entry in double quotes on one line, which the text version would have rejected and this one accepts.
- `packages/engine/test/manager.test.ts` also pins the failure mode of the rejected union fix: a warm
  engine whose capabilities omit a variant must not be routed it, even when its plugin expects it.

## Consequences

- `npm run dev` reaches a running backend; registering works there.
- A Compose stack answers a bot game with a real Stockfish move.
- Routing a game by its platform variant name works on any registered engine that can play it.
- The engine suite no longer speaks only the engine's vocabulary.

## Out of scope

- Chess960 remains withheld from the lobby (ADR-0099); `chess960` routing is untouched here.
- No change to bot strength, move selection, or the `EngineBotMover` itself.
