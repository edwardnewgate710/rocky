import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BOT_ACCOUNTS, botAccountByLevel, botAccountByUserId } from '../src/bot/catalogue';

test('bot catalogue matches migration 0021_engine_bots.sql exactly', () => {
  const candidatePaths = [
    join(__dirname, '..', '..', '..', 'persistence', 'migrations', '0021_engine_bots.sql'),
    join(process.cwd(), 'packages', 'persistence', 'migrations', '0021_engine_bots.sql'),
    join(process.cwd(), '..', 'persistence', 'migrations', '0021_engine_bots.sql'),
  ];
  const migrationPath = candidatePaths.find((p) => existsSync(p));
  assert.ok(migrationPath, '0021_engine_bots.sql migration file must exist');

  const sql = readFileSync(migrationPath, 'utf8');

  assert.ok(BOT_ACCOUNTS.length >= 3, 'catalogue contains at least three bot accounts');

  for (const bot of BOT_ACCOUNTS) {
    assert.ok(sql.includes(bot.userId), `migration 0021 must contain UUID ${bot.userId}`);
    assert.ok(sql.includes(bot.handle), `migration 0021 must contain handle ${bot.handle}`);
  }
});

test('botAccountByLevel resolves valid levels and returns undefined for unknown levels', () => {
  assert.equal(botAccountByLevel('novice')?.handle, 'gambit-novice');
  assert.equal(botAccountByLevel('club')?.handle, 'gambit-club');
  assert.equal(botAccountByLevel('master')?.handle, 'gambit-master');
  assert.equal(botAccountByLevel('unknown'), undefined);
});

test('botAccountByUserId resolves valid user ids and returns undefined for unknown ids', () => {
  assert.equal(botAccountByUserId('00000000-0000-7000-8000-000000000001')?.level, 'novice');
  assert.equal(botAccountByUserId('00000000-0000-7000-8000-000000000002')?.level, 'club');
  assert.equal(botAccountByUserId('00000000-0000-7000-8000-000000000003')?.level, 'master');
  assert.equal(botAccountByUserId('00000000-0000-0000-0000-000000000000'), undefined);
});
