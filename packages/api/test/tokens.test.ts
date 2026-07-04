import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AccessTokenService } from '../src/auth/tokens';
import { ManualClock } from '../src/ports/clock';
import { uuidv7Generator } from '../src/ports/ids';

const SECRET = 'a-signing-secret-of-at-least-32-bytes!!';

function svc(clock: ManualClock, ttlSec = 900): AccessTokenService {
  return new AccessTokenService({ secret: SECRET, ttlSec, clock, ids: uuidv7Generator });
}

test('access token: issue and verify round-trips claims', () => {
  const clock = new ManualClock(1_700_000_000_000);
  const s = svc(clock);
  const { token, claims } = s.issue({ userId: 'u1', handle: 'alice', roles: ['user', 'admin'] });
  const result = s.verify(token);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.claims.sub, 'u1');
    assert.equal(result.claims.handle, 'alice');
    assert.deepEqual(result.claims.roles, ['user', 'admin']);
    assert.equal(result.claims.exp - result.claims.iat, 900);
    assert.equal(result.claims.jti, claims.jti);
  }
});

test('access token: identify projects an Identity', () => {
  const clock = new ManualClock(1_700_000_000_000);
  const s = svc(clock);
  const { token } = s.issue({ userId: 'u2', handle: 'bob', roles: ['moderator'] });
  const id = s.identify(token);
  assert.ok(id);
  assert.equal(id?.userId, 'u2');
  assert.deepEqual(id?.roles, ['moderator']);
});

test('access token: tampered payload fails signature check', () => {
  const clock = new ManualClock(1_700_000_000_000);
  const s = svc(clock);
  const { token } = s.issue({ userId: 'u1', handle: 'alice', roles: ['user'] });
  const [h, , sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'admin', handle: 'x', roles: ['admin'], iat: 1, exp: 9_999_999_999, jti: 'j' })).toString('base64url');
  const result = s.verify(`${h}.${forged}.${sig}`);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'bad_signature');
});

test('access token: expiry is enforced against the clock', () => {
  const clock = new ManualClock(1_700_000_000_000);
  const s = svc(clock, 60);
  const { token } = s.issue({ userId: 'u1', handle: 'alice', roles: ['user'] });
  clock.advance(61_000);
  const result = s.verify(token);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'expired');
  assert.equal(s.identify(token), null);
});

test('access token: a token signed with a different secret is rejected', () => {
  const clock = new ManualClock(1_700_000_000_000);
  const s1 = svc(clock);
  const s2 = new AccessTokenService({ secret: 'another-secret-of-at-least-32-bytes!!!', ttlSec: 900, clock, ids: uuidv7Generator });
  const { token } = s1.issue({ userId: 'u1', handle: 'alice', roles: ['user'] });
  assert.equal(s2.verify(token).ok, false);
});

test('access token: malformed structures are rejected', () => {
  const clock = new ManualClock(1_700_000_000_000);
  const s = svc(clock);
  assert.equal(s.verify('not.a.token.at.all').ok, false);
  assert.equal(s.verify('only-one-part').ok, false);
  assert.equal(s.identify('garbage'), null);
});

test('access token: constructor rejects a short secret', () => {
  const clock = new ManualClock(0);
  assert.throws(
    () => new AccessTokenService({ secret: 'too-short', ttlSec: 900, clock, ids: uuidv7Generator }),
    /at least 32 bytes/,
  );
});
