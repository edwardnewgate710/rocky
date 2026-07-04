# Gambit — an open-source chess platform

An ambitious, AGPL-licensed chess platform targeting feature parity with
Lichess and Chess.com, plus a first-class AI layer. This repository is built
**milestone by milestone**, and every milestone ships real, tested, typed code —
no skeletons, no placeholders.

> **Status:** Milestone 1 complete — a perft-verified, variant-aware chess rules
> engine. See [`docs/ROADMAP.md`](docs/ROADMAP.md) for what is built vs. planned.

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
│   └── chess-core/         # ✅ Rules engine: legal moves, variants, FEN, SAN, perft
├── docs/
│   ├── ARCHITECTURE.md     # Full system design (services, data, real-time, AI, security)
│   └── ROADMAP.md          # Milestone plan with acceptance criteria
└── README.md
```

Planned packages (see roadmap): `game-server` (WebSocket authority),
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

## License

AGPL-3.0-or-later, matching Lichess so server modifications stay open.
