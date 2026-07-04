# Gambit — an open-source chess platform

An ambitious, AGPL-licensed chess platform targeting feature parity with
Lichess and Chess.com, plus a first-class AI layer. This repository is built
**milestone by milestone**, and every milestone ships real, tested, typed code —
no skeletons, no placeholders.

> **Status:** Milestones 1–2 complete — a perft-verified, variant-aware chess
> rules engine (`@chess-platform/core`) and an event-sourced game authority with
> clocks (`@chess-platform/game`). See [`docs/ROADMAP.md`](docs/ROADMAP.md) for
> what is built vs. planned.

## Why "milestone by milestone" and not "all at once"

A platform of this scope (Lichess is ~15 years of work by many contributors) is
not something any single automated pass can produce as production-ready code.
Anything that claims to would be handing you thousands of placeholder files.
Instead we build a correct foundation first and grow it in vertical slices, each
one merged only after it is tested and reviewed.

## Repository layout (monorepo)

```
chess-platform/
├── packages/
│   ├── chess-core/         # ✅ Rules engine: legal moves, variants, FEN, SAN, perft
│   └── game/               # ✅ Event-sourced game authority: clocks, commands, replay
├── docs/
│   ├── ARCHITECTURE.md     # Full system design (services, data, real-time, AI, security)
│   └── ROADMAP.md          # Milestone plan with acceptance criteria
├── .github/workflows/      # CI: build + typecheck + test both packages
└── README.md
```

Planned packages (see roadmap): `realtime-gateway` (WebSocket fanout),
`api` (REST/GraphQL), `ai-orchestrator`, `web` (frontend), `engine-bridge`
(Stockfish/Fairy-Stockfish), `search`, and `infra` (Terraform/K8s).

## `@chess-platform/core`

A dependency-free, fully-typed chess engine.

- Legal move generation for **standard, Chess960, King of the Hill, Atomic,
  Crazyhouse, Three-Check, Horde, and Racing Kings**.
- FEN parse/serialize (incl. Crazyhouse pockets), UCI + SAN, check / checkmate /
  stalemate / draw detection, and variant win conditions.
- Immutable `Position` API — playing a move returns a new position.
- **Correctness proven by `perft`** against the published reference node counts
  (start position, Kiwipete, and three EPD edge-case positions).

### Quick start

```ts
import { Position } from '@chess-platform/core';

let pos = Position.initial();                 // standard start
pos = pos.play('e2e4').play('e7e5');          // UCI
console.log(pos.fen());
console.log(pos.legalMoves().map((m) => pos.toSan(m)));
console.log(pos.status());                     // { over: false }

const atomic = Position.initial('atomic');
const koth = Position.initial('kingofthehill');
```

### Build & test

```bash
cd packages/chess-core
npm install
npm run build      # tsc → dist/
npm test           # compiles tests, runs perft + rules suites via node --test
```

All 14 tests pass, including 5 perft positions to depths that exercise
castling, en passant, promotions, pins, and discovered checks.

## `@chess-platform/game`

An event-sourced game authority built on the core engine. A game is an
append-only sequence of events; state is a pure fold, so any game reconstructs
exactly from its log.

```ts
import { Game } from '@chess-platform/game';

let { game } = Game.create({
  gameId: 'g1',
  timeControl: { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' },
  players: { white: 'alice', black: 'bob' },
  rated: true,
  at: Date.now(),
});

({ game } = game.playMove('e2e4', Date.now()));
({ game } = game.playMove('e7e5', Date.now()));
console.log(game.status);      // { over: false }
console.log(game.snapshot().clock.remaining);

// Reconstruct from the durable event log:
const rebuilt = Game.fromEvents(eventLog);
```

- Server-authoritative legality (clients never decide results).
- Clocks: Fischer increment, Bronstein/US delay, sudden-death, unlimited.
- Commands: move, resign, draw offer/accept/decline, flag claim, abort.
- 18 tests pass; exact event-log reconstruction; ~1.17ms/game replay.

```bash
cd packages/game && npm install && npm run build && npm test
```

## License

AGPL-3.0-or-later, matching Lichess so server modifications stay open.
