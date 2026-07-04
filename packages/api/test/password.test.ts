import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ScryptPasswordHasher } from '../src/auth/password';

const hasher = new ScryptPasswordHasher({ N: 1024 });

test('scrypt: hash then verify round-trips', async () => {
  const encoded = await hasher.hash('correct horse battery staple');
  assert.match(encoded, /^scrypt\$N=1024,r=8,p=1\$/);
  assert.equal(await hasher.verify('correct horse battery staple', encoded), true);
});

test('scrypt: wrong password fails', async () => {
  const encoded = await hasher.hash('super-secret-1');
  assert.equal(await hasher.verify('super-secret-2', encoded), false);
});

test('scrypt: distinct salts produce distinct encodings', async () => {
  const a = await hasher.hash('same-password-xyz');
  const b = await hasher.hash('same-password-xyz');
  assert.notEqual(a, b);
  assert.equal(await hasher.verify('same-password-xyz', a), true);
  assert.equal(await hasher.verify('same-password-xyz', b), true);
});

test('scrypt: malformed encodings verify false, never throw', async () => {
  assert.equal(await hasher.verify('pw', 'not-a-hash'), false);
  assert.equal(await hasher.verify('pw', 'scrypt$bad$params$here'), false);
  assert.equal(await hasher.verify('pw', 'argon2$x$y$z'), false);
  assert.equal(await hasher.verify('pw', ''), false);
});

test('scrypt: rejects too-short passwords at hash time', async () => {
  await assert.rejects(() => hasher.hash('short'), /at least 8/);
});

test('scrypt: a hash from default params verifies under a differently-configured hasher', async () => {
  // The encoding is self-describing, so parameters can evolve without breaking old hashes.
  const producer = new ScryptPasswordHasher({ N: 2048 });
  const consumer = new ScryptPasswordHasher({ N: 1024 });
  const encoded = await producer.hash('evolving-params-1');
  assert.equal(await consumer.verify('evolving-params-1', encoded), true);
});
