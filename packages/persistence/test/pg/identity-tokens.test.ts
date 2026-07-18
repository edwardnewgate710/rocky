import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import { createPool } from '../../src/pg/pool';
import { migrate } from '../../src/pg/migrate';
import { PgIdentityTokensRepository, PgUsersRepository } from '../../src/pg/repositories';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

describe('PgIdentityTokensRepository', { skip }, () => {
  it('creates and atomically consumes a token', async () => {
    const pool = createPool();
    try {
      await migrate(pool, join(process.cwd(), 'migrations'));
      const users = new PgUsersRepository(pool);
      const tokens = new PgIdentityTokensRepository(pool);

      const user = await users.create({
        id: '01918300-0000-0000-0000-000000000000',
        handle: 'tokenuser',
        email: 'tokenuser@example.com',
        emailHash: createHash('sha256').update('tokenuser@example.com').digest(),
      });

      const tokenHash = createHash('sha256').update(randomBytes(32)).digest('hex');
      const expiresAt = new Date(Date.now() + 3600_000); // +1 hour

      await tokens.create({
        tokenHash,
        userId: user.id,
        kind: 'password_reset',
        expiresAt,
      });

      // 1st consume attempt: should succeed
      const at = new Date();
      const consumed = await tokens.consume(tokenHash, 'password_reset', at);
      assert.ok(consumed);
      assert.equal(consumed.userId, user.id);

      // 2nd consume attempt: should fail (already used)
      const consume2 = await tokens.consume(tokenHash, 'password_reset', new Date());
      assert.equal(consume2, null);

      // Attempt with wrong kind
      const tokenHash2 = createHash('sha256').update(randomBytes(32)).digest('hex');
      await tokens.create({
        tokenHash: tokenHash2,
        userId: user.id,
        kind: 'email_verify',
        expiresAt,
      });
      const consumeWrongKind = await tokens.consume(tokenHash2, 'password_reset', new Date());
      assert.equal(consumeWrongKind, null);

      // Attempt after expiry
      const tokenHash3 = createHash('sha256').update(randomBytes(32)).digest('hex');
      await tokens.create({
        tokenHash: tokenHash3,
        userId: user.id,
        kind: 'password_reset',
        expiresAt: new Date(Date.now() - 1000), // already expired
      });
      const consumeExpired = await tokens.consume(tokenHash3, 'password_reset', new Date());
      assert.equal(consumeExpired, null);
    } finally {
      await pool.end();
    }
  });
});
