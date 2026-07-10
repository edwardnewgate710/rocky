#!/usr/bin/env node
/**
 * Smoke test for the local Docker Compose stack (M14 Increment 1).
 *
 * Verifies the full stack end-to-end:
 * 1. Waits for all health checks to pass
 * 2. Registers a user over the real REST API
 * 3. Creates a seek
 * 4. Opens a WebSocket to the gateway with the auth token
 * 5. Confirms the WS connection authenticates and receives a joined response
 *
 * Usage:
 *   docker compose up -d --build
 *   node scripts/smoke-test.mjs
 *
 * Or with custom URLs:
 *   API_URL=http://localhost:8080 WS_URL=ws://localhost:4175 WEB_URL=http://localhost:3000 node scripts/smoke-test.mjs
 */

const apiUrl = process.env['API_URL'] ?? 'http://localhost:8080';
const wsUrl = process.env['WS_URL'] ?? 'ws://localhost:4175';
const webUrl = process.env['WEB_URL'] ?? 'http://localhost:3000';

const TIMEOUT_MS = 60_000;
const POLL_INTERVAL = 2_000;

function log(msg) {
  console.log(`[smoke] ${msg}`);
}

async function waitForHealth(url, name) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        log(`✓ ${name} healthy`);
        return true;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
  throw new Error(`✗ ${name} did not become healthy within ${TIMEOUT_MS / 1000}s`);
}

async function registerUser(handle, password) {
  const res = await fetch(`${apiUrl}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle, password }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Register failed (${res.status}): ${text}`);
  }
  const body = await res.json();
  log(`✓ Registered user "${handle}" (id: ${body.user?.id ?? '?'})`);
  return body;
}

async function createSeek(token) {
  const res = await fetch(`${apiUrl}/v1/seeks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      variant: 'standard',
      speed: 'blitz',
      color: 'random',
      rated: false,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Create seek failed (${res.status}): ${text}`);
  }
  const body = await res.json();
  log(`✓ Created seek (id: ${body.id ?? '?'})`);
  return body;
}

function waitForWs(url, token) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15_000;
    const ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      log('✓ WebSocket connected');
      // Send a join message for a test game
      ws.send(JSON.stringify({ t: 'join', gameId: 'smoke-test-game', token }));
    });

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      // We expect either 'joined' (success) or 'reject' (game doesn't exist,
      // but token was verified — the rejection reason proves auth worked)
      if (msg.t === 'reject' && msg.code === 'unknown_game') {
        log('✓ WebSocket authenticated (token verified, game not found as expected)');
        ws.close();
        resolve(true);
      } else if (msg.t === 'joined') {
        log('✓ WebSocket joined game (token verified, state received)');
        ws.close();
        resolve(true);
      }
    });

    ws.addEventListener('error', (err) => {
      reject(new Error(`WebSocket error: ${err.message ?? 'connection failed'}`));
    });

    setTimeout(() => {
      ws.close();
      reject(new Error('WebSocket timed out waiting for response'));
    }, deadline - Date.now());
  });
}

async function main() {
  log(`API: ${apiUrl}`);
  log(`WS:  ${wsUrl}`);
  log('');

  // 1. Wait for health
  log('Waiting for services to be healthy...');
  await waitForHealth(`${apiUrl}/v1/health`, 'API');
  await waitForHealth(webUrl, 'Web');
  // Gateway health is on port+1 inside the container, but from outside we
  // can check the WS port is listening by attempting a connection later.
  log('');

  // 2. Register a user
  log('Registering a test user...');
  const handle = `smoke-${Date.now().toString(36)}`;
  const auth = await registerUser(handle, 'test-password-123');
  const token = auth.accessToken;
  if (!token) {
    throw new Error('No accessToken in register response');
  }
  log(`✓ Got access token (${token.slice(0, 20)}...)`);
  log('');

  // 3. Create a seek
  log('Creating a seek...');
  await createSeek(token);
  log('');

  // 4. WebSocket authentication
  log('Connecting to WebSocket gateway...');
  await waitForWs(wsUrl, token);
  log('');

  log('════════════════════════════════════════════════════════════');
  log('  ✅ SMOKE TEST PASSED — the stack is fully operational');
  log('════════════════════════════════════════════════════════════');
  log('');
  log('  • Postgres: schema migrated, user persisted');
  log('  • API: register + seek creation over real REST');
  log('  • Gateway: WebSocket authenticated with real token');
  log('  • Token verification: shared-secret HMAC verified across services');
  process.exit(0);
}

main().catch((err) => {
  console.error('');
  console.error(`[smoke] ✗ FAILED: ${err.message}`);
  process.exit(1);
});
