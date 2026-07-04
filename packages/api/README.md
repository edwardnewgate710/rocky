# `@chess-platform/api`

The stateless REST + identity service for Gambit. It consumes
`@chess-platform/persistence` (repositories, Glicko-2, UUIDv7) and the domain
packages (`@chess-platform/game`, `@chess-platform/core`), and exposes a small,
dependency-free HTTP API with a published OpenAPI 3.1 contract.

## Design

- **Node built-in HTTP + a typed router.** No web framework. Routes couple their
  OpenAPI contract, auth policy, and handler in one place; handlers receive a
  `RequestContext` and return a `HandlerResult` (they never touch the socket).
- **Dependency injection via `createApiServer(deps)`.** Repositories, the
  password hasher, the token service, the clock, and the id generator all arrive
  explicitly — no module-level singletons. Tests wire in-memory fakes; production
  wires Postgres. The code in between is identical.
- **Provider-agnostic identity.**
  - `PasswordHasher` abstraction with a built-in **scrypt** default
    (`ScryptPasswordHasher`). The stored hash is a self-describing string, so
    swapping in argon2id or a KMS is a one-line injection with no data migration.
  - **HMAC-SHA256 (HS256) access tokens** — self-contained, verified with no
    database round-trip, so the service scales horizontally.
  - **Opaque refresh tokens**, stored only as a SHA-256 hash, **single-use with
    rotation**. Replaying an already-rotated token is treated as theft and burns
    the whole session chain.
- **RBAC** (`user`, `coach`, `tournament_director`, `moderator`, `admin`)
  enforced declaratively per route and re-checked in handlers where ownership
  matters (e.g. seek cancellation).
- **Minimal dependencies.** Everything is `node:crypto` / `node:http`; the root
  entry pulls in no third-party runtime dependency. Postgres wiring is isolated
  behind the `@chess-platform/api/pg` subpath.

## Endpoints (v1)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/health` | — | Liveness probe |
| GET | `/v1/openapi.json` | — | OpenAPI 3.1 document |
| POST | `/v1/auth/register` | — | Create an account |
| POST | `/v1/auth/login` | — | Password login |
| POST | `/v1/auth/refresh` | — | Rotate a refresh token |
| POST | `/v1/auth/logout` | bearer | Revoke the presented session |
| GET | `/v1/auth/sessions` | bearer | List the caller's sessions |
| GET | `/v1/users/me` | bearer | The authenticated account |
| GET | `/v1/users/:handle` | — | Public profile + ratings |
| GET | `/v1/users/:handle/ratings` | — | Ratings across variants |
| GET | `/v1/users/:handle/games` | — | Recent games |
| POST | `/v1/users/:userId/roles` | admin | Grant a role |
| GET | `/v1/leaderboard/:variant` | — | Top players for a variant |
| GET | `/v1/seeks` | — | List open seeks |
| POST | `/v1/seeks` | bearer | Create a seek |
| DELETE | `/v1/seeks/:id` | bearer | Cancel a seek (owner or moderator) |
| GET | `/v1/games/:id` | — | Game summary |

## Quick start (in-memory, no database)

```ts
import {
  createApiServer, createInMemoryRepositories, resolveConfig,
  ScryptPasswordHasher, AccessTokenService, systemClock, uuidv7Generator,
} from '@chess-platform/api';

const clock = systemClock;
const ids = uuidv7Generator;
const config = resolveConfig({ accessTokenSecret: process.env.ACCESS_TOKEN_SECRET! });
const tokens = new AccessTokenService({
  secret: config.accessTokenSecret, ttlSec: config.accessTokenTtlSec, clock, ids,
});

const server = createApiServer({
  repos: createInMemoryRepositories(),
  hasher: new ScryptPasswordHasher(),
  tokens, clock, ids, config,
});

await server.listen(8080);
```

## Production (Postgres)

Requires `ACCESS_TOKEN_SECRET` and `DATABASE_URL`.

```ts
import { createPgApiServer } from '@chess-platform/api/pg';

const { server, pool } = createPgApiServer();
await server.listen(Number(process.env.PORT ?? 8080));
// pool.end() on shutdown
```

Or run the bundled entrypoint: `npm run serve`.

## Build, test, publish spec

```bash
cd packages/api
npm install
npm run build      # tsc -> dist/
npm test           # compiles + runs the suite via node --test
npm run openapi    # regenerates ./openapi.json from the live route table
```

45 tests pass (auth flows, authorization matrix, token/scrypt units, router
edge cases, resources, and OpenAPI self-consistency). Strict TypeScript, zero
errors.
