import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const compose = await readFile(new URL('../../docker-compose.yml', import.meta.url), 'utf8');

test('the local Compose stack publishes every port on loopback only', () => {
  const publishedPorts = [...compose.matchAll(/^\s+- "([^"]+:[^"]+)"$/gm)].map((match) => match[1]);

  assert.deepEqual(publishedPorts, [
    '127.0.0.1:5432:5432',
    '127.0.0.1:6379:6379',
    '127.0.0.1:${PORT:-8080}:8080',
    '127.0.0.1:${GATEWAY_PORT:-4175}:4175',
    '127.0.0.1:${WEB_PORT:-3000}:8080',
  ]);
});
