# Running Gambit Locally

This guide covers the **local runnable stack** (M14 Increment 1): a single
`docker compose up` command that brings the entire platform live with real
Postgres, a real API, a real WebSocket gateway, and the web frontend.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with the Compose plugin (v2+)
- Postgres and nginx run inside containers — no local install needed
- [Node.js](https://nodejs.org/) 22+ on the host, only if you want to run
  `scripts/smoke-test.mjs` outside a container (it uses the built-in `fetch`
  and `WebSocket` globals)

## Quick start

```bash
# 1. Copy the env template (optional — defaults work for local dev)
cp .env.example .env

# 2. Start the full stack
docker compose up --build

# 3. Open the browser
open http://localhost:3000
```

That's it. You can register a user, and the platform is live.

> **If the API image fails to build, or starts and immediately exits with `MODULE_NOT_FOUND`:** run
> `npm run check:build-order`. The container images build and copy their packages from lists that
> are maintained by hand, and those lists went stale once already — see ADR-0065. That check catches
> it in seconds and runs in CI, but it is the first thing to try if the stack will not come up.

## What runs

| Service | Container | Port | Description |
|---|---|---|---|
| **Postgres** | `postgres` | 5432 | Postgres 16 with the schema auto-migrated on API startup |
| **API** | `api` | 8080 | REST API (`@chess-platform/api`) backed by real Postgres |
| **Gateway** | `gateway` | 4175 | WebSocket gateway (`@chess-platform/realtime-gateway`) with shared-secret token verification |
| **Web** | `web` | 3000 | Vite-built SPA served by nginx, proxying `/v1` → API and `/ws` → gateway |

## How it works

### Postgres + migrations

The `postgres` service uses the official `postgres:16-alpine` image. The API
container runs `npm run migrate --workspace @chess-platform/persistence` before
starting the server, so the schema is applied automatically on first boot. The
`schema_migrations` table tracks applied migrations with checksums, so
re-starts are idempotent.

### API service

The API uses `packages/api/src/scripts/serve.ts`, which calls
`createPgApiServer()` from `bootstrap.ts` — the real, Postgres-backed
composition root. Config is entirely via environment variables:

- `DATABASE_URL` — Postgres connection string
- `ACCESS_TOKEN_SECRET` — HMAC signing secret (shared with the gateway)
- `PORT` — listen port (default 8080)

Health check: `GET /v1/health` returns `{ status: "ok" }`.

### Gateway service

The gateway runs `services/gateway/src/serve.ts`, which creates a WebSocket
server wrapping the `RealtimeGateway`. Token verification uses the same
`ACCESS_TOKEN_SECRET` as the API — the gateway constructs its own
`AccessTokenService` to verify tokens locally (stateless HMAC, no API
round-trip). This is the `TokenVerifier` port from ADR-0004.

The gateway persists game events to the shared Postgres event store, so games
survive gateway restarts and rehydrate exactly. With `REDIS_URL` set (the Compose
default), Redis pub/sub fans authoritative broadcasts across gateway nodes;
without it, the gateway falls back to `InMemoryPubSub` for single-node use.
See ADR-0007 (local stack/durability) and ADR-0008 (Redis fanout).

Health check: `GET :4176/health` returns `{ status: "ok" }` (health runs on
port+1, separate from the WebSocket port).

**Play vs Computer** needs two things and fails quietly without either: `ENGINE_BOT=1`, and an
engine binary at `STOCKFISH_PATH`. The gateway image installs Stockfish at
`/usr/games/stockfish` and Compose sets `ENGINE_BOT` by default, so `docker compose up` gives
you a working opponent. If neither is present the gateway logs
`ENGINE_BOT requires an engine binary (set STOCKFISH_PATH)` and the lobby still offers the mode
while the opponent never moves. Confirm with:

```bash
docker compose logs gateway | grep "EngineBotMover is enabled"
```

### Web service

The web container builds the SPA with `vite build` and serves the static output
via nginx. Nginx proxies:
- `/v1/*` → `api:8080` (REST API)
- `/ws` → `gateway:4175` (WebSocket, with upgrade headers)

The frontend's `resolveConfig()` derives API and WS URLs from the page origin,
so it works automatically when served from the same host.

### Front-end dev server

For UI work you can run Vite directly instead of rebuilding the container:

```bash
npm run dev --workspace @chess-platform/web   # http://127.0.0.1:5173
```

Because `resolveConfig()` uses the page origin, the app calls `/v1/...` on the dev server itself,
so the dev server proxies `/v1` and `/ws` to a backend you are already running — by default the
Compose one (`api` on 8080, `gateway` on 4175). Start the backend first:

```bash
docker compose up -d postgres redis api gateway
```

Point elsewhere with `GAMBIT_DEV_API_URL` / `GAMBIT_DEV_WS_URL`. Without the proxy every API call
returns 404 from Vite — registering an account answers `HTTP 404`, which looks like a broken backend
rather than a missing proxy.

## Smoke test

A smoke test script is provided at `scripts/smoke-test.mjs`. It verifies the
full stack end-to-end:

```bash
# Start the stack first
docker compose up -d --build

# Run the smoke test
node scripts/smoke-test.mjs
```

The script:
1. Waits for all health checks to pass
2. Registers a user over the real REST API
3. Creates a seek
4. Opens a WebSocket connection to the gateway with the auth token
5. Confirms the WS connection is accepted

## Environment variables

| Variable | Default | Required | Description |
|---|---|---|---|
| `ACCESS_TOKEN_SECRET` | `dev-secret-...` | Yes (≥32 bytes) | HMAC secret shared between API and gateway |
| `POSTGRES_PASSWORD` | `gambit_dev` | No | Postgres password |
| `DATABASE_URL` | derived from `POSTGRES_PASSWORD` | No | Postgres connection string for the API container; Compose builds this automatically — do not set it yourself |
| `PORT` | `8080` | No | API host port |
| `GATEWAY_PORT` | `4175` | No | Gateway WebSocket host port |
| `WEB_PORT` | `3000` | No | Web frontend host port |
| `ENGINE_BOT` | unset (`0`) | No | Set to `"1"` to host the autonomous engine bot mover in the gateway (ADR-0080) |
| `STOCKFISH_PATH` | unset | Required if `ENGINE_BOT=1` | Path to Stockfish UCI executable binary |


**Never commit real secrets.** The `.env.example` has development defaults only.

## Stopping

```bash
docker compose down          # stop containers
docker compose down -v       # stop + delete the Postgres data volume
```

## Architecture notes

- **Durable authority + multi-node fanout:** The gateway persists the
  authoritative game event log in Postgres, so game state survives gateway
  restarts and rehydrates on demand. Redis pub/sub, enabled via `REDIS_URL`,
  fans broadcasts across gateway replicas; omitting `REDIS_URL` selects the
  in-memory single-node fallback. Sharded authority remains a later M14 step.
- **No secrets in the repo:** All secrets come from environment variables.
  The `.env.example` has development-only defaults.
- **Multi-stage Dockerfiles:** Each Dockerfile builds in a full Node image and
  runs a lean runtime image, keeping image sizes reasonable.
- **Health-gated startup:** Compose uses `depends_on` with `condition:
  service_healthy` so services start in order: Postgres → API → gateway → web.
