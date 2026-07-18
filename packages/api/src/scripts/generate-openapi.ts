/**
 * @packageDocumentation
 * Generate and publish `openapi.json` at the package root. The spec is produced
 * from the live route table (via in-memory fakes — no database required), so the
 * committed artifact always matches the served contract. Run with
 * `npm run openapi` after building.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ScryptPasswordHasher } from '../auth/password';
import { AccessTokenService } from '../auth/tokens';
import { resolveConfig } from '../config';
import { createInMemoryRepositories } from '../fakes';
import { systemClock } from '../ports/clock';
import { uuidv7Generator } from '../ports/ids';
import { createApiServer } from '../server';
import { InMemoryGameLauncher } from '../tournament/launcher';
import { ConsoleEmailSender } from '../ports/email';

function main(): void {
  const clock = systemClock;
  const ids = uuidv7Generator;
  // A throwaway secret used only to construct the (unused-for-signing) token service.
  const config = resolveConfig({ accessTokenSecret: 'openapi-generation-placeholder-secret-32b' });
  const tokens = new AccessTokenService({
    secret: config.accessTokenSecret,
    ttlSec: config.accessTokenTtlSec,
    clock,
    ids,
  });
  const repos = createInMemoryRepositories();
  const server = createApiServer({
    repos,
    hasher: new ScryptPasswordHasher(),
    tokens,
    clock,
    ids,
    config,
    rateLimiter: new (require('../ports/in-memory-rate-limiter').InMemoryRateLimiter)(clock),
    tournamentRepo: repos.tournaments,
    gameLauncher: new InMemoryGameLauncher(ids),
    liveView: { activeGames: () => [] },
    emailSender: new ConsoleEmailSender(),
  });

  const doc = server.openapiDocument();
  const outPath = join(__dirname, '..', '..', 'openapi.json');
  writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`Wrote OpenAPI spec to ${outPath}`);
}

main();
