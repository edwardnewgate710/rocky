# Gambit — an open-source chess platform

An ambitious, AGPL-licensed chess platform targeting feature parity with
Lichess and Chess.com, plus a first-class AI layer. This repository is built
**milestone by milestone**, and every milestone ships real, tested, typed code —
no skeletons, no placeholders.

> **Status:** Milestones 1–3 complete — a perft-verified, variant-aware chess
> rules engine (`@chess-platform/core`), an event-sourced game authority with
> clocks (`@chess-platform/game`), and a real-time gateway with authoritative
> move fanout, presence, and reconnect/resume (`@chess-platform/realtime-gateway`).
> See [`docs/ROADMAP.md`](docs/ROADMAP.md) for what is built vs. planned.

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
│   ├── game/               # ✅ Event-sourced game authority: clocks, commands, replay
│   └── realtime-gateway/   # ✅ WebSocket rooms, presence, authoritative fanout, resume
├── docs/
│   ├── ARCHITECTURE.md     # Full system design (services, data, real-time, AI, security)
│   └── ROADMAP.md          # Milestone plan with acceptance criteria
├── .github/workflows/      # CI: build + typecheck + test every package
└── README.md
```

Planned packages (see roadmap): `api` (REST/GraphQL), `ai-orchestrator`,
`web` (frontend), `engine-bridge` (Stockfish/Fairy-Stockfish), `search`, and
`infra` (Terraform/K8s).

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

## `@chess-platform/realtime-gateway`

The real-time edge: it binds client connections to game rooms and the Game
Authority, and speaks a small, server-authoritative wire protocol. Built on
`@chess-platform/game`; dependency-free, with WebSocket and Redis bindings as
documented adapter seams (`transport.ts`, `pubsub.ts`).

- **Server is the authority.** A client sends an *intended* move with a
  monotonic `clientSeq`; the gateway validates it via the engine and either
  broadcasts the applied move or returns a `reject` referencing that `clientSeq`
  so the client rolls back its optimistic render.
- **Rooms, presence, and fanout.** Players and spectators join a game room;
  authoritative moves fan out to everyone. Cross-node fanout goes through a
  `PubSub` interface (in-memory for tests/dev, Redis in production).
- **Race-free authority.** Commands are serialized **per game**, so concurrent
  intents can never interleave into a corrupt state.
- **Reconnect/resume.** A reconnecting client rejoins (seat + current state
  restored) and asks for every move it missed since `lastPly`.
- **Latency compensation.** `ping`/`pong` carry a server timestamp; clocks stay
  authoritative on the server and clients interpolate locally.
- 26 tests pass, including a reconnection integration test and a fanout load
  test: **p99 < 50ms** broadcasting to 5,000 active subscribers with 50,000
  idle connections registered.

```ts
import {
  GameAuthority, RealtimeGateway, InMemoryPubSub, InMemoryConnection,
} from '@chess-platform/realtime-gateway';

const pubsub = new InMemoryPubSub();
const authority = new GameAuthority(pubsub);
const gateway = new RealtimeGateway(authority, pubsub);

authority.createGame({
  gameId: 'g1',
  timeControl: { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' },
  players: { white: 'alice', black: 'bob' },
  rated: true,
});

const conn = new InMemoryConnection();       // a `ws` socket in production
gateway.handleConnection(conn);
conn.deliver({ t: 'join', gameId: 'g1', userId: 'alice' });
conn.deliver({ t: 'move', gameId: 'g1', uci: 'e2e4', clientSeq: 1 });
```

```bash
cd packages/realtime-gateway && npm install && npm run build && npm test
```

> Note: connection identity is trusted from the upstream for now; authenticated
> sessions, passkeys, and RBAC arrive with the API/identity milestone (M4).

## License

AGPL-3.0-or-later, matching Lichess so server modifications stay open.
