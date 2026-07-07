/**
 * @packageDocumentation
 * Minimal backend harness for M6 e2e acceptance tests.
 *
 * Composes the existing API (with in-memory fakes) + gateway (with in-memory
 * pub/sub) + a `ws` WebSocket server + a random-move bot, all in a single
 * process. This is NOT the deployable M14 service — it is the minimal harness
 * sufficient to run the Playwright full-game specs locally and in CI.
 *
 * The harness exposes:
 * - HTTP API on `apiPort` (default 4174) — register, login, seeks, games.
 * - Bridge route `POST /e2e/games` — test-only game creation (stand-in for M7
 *   matchmaking). Calls `authority.createGame(...)` + `bot.registerGame(...)`.
 *   Do NOT add this to the product API.
 * - WebSocket gateway on `wsPort` (default 4175) — join, move, state, resume.
 * - A bot that auto-joins games and plays random legal moves.
 *
 * Usage:
 *   node dist/main.js                 # defaults
 *   API_PORT=4180 WS_PORT=4181 node dist/main.js
 */
export { createHarness, type Harness, type HarnessOptions } from './harness.js';
export { serveHarness } from './serve.js';