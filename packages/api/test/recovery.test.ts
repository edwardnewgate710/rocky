import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { startHarness } from './helpers';

describe('Identity Recovery (API)', () => {
  it('handles password reset flow and email verification', async () => {
    const env = await startHarness();

    try {
      // 1. Register a user with email
      const registerRes = await env.json('POST', '/v1/auth/register', {
        body: {
          handle: 'recoverytester',
          password: 'oldpassword123',
          email: 'recoverytester@example.com',
        },
      });
      assert.equal(registerRes.status, 201);
      const authData = registerRes.body;
      assert.ok(authData.user);

      // We should receive an email verification email
      const sentEmails = env.emailSender.sent;
      assert.equal(sentEmails.length, 1);
      assert.equal(sentEmails[0].to, 'recoverytester@example.com');
      assert.equal(sentEmails[0].type, 'email_verify');

      const verifyToken = sentEmails[0].token;

      // Verify the email via endpoint
      const verifyRes = await env.json('POST', '/v1/auth/email/verify', {
        body: { token: verifyToken },
      });
      assert.equal(verifyRes.status, 204);

      // Check DB that it's verified
      const userAfterVerify = await env.repos.users.findByHandle('recoverytester');
      assert.ok(userAfterVerify?.emailVerifiedAt);

      // Attempting to verify again with the same token should fail
      const verifyAgainRes = await env.json('POST', '/v1/auth/email/verify', {
        body: { token: verifyToken },
      });
      assert.equal(verifyAgainRes.status, 401);

      // 2. Request Password Reset
      const resetReqRes = await env.json('POST', '/v1/auth/password-reset/request', {
        body: { handleOrEmail: 'recoverytester@example.com' },
      });
      assert.equal(resetReqRes.status, 202); // Anti-enumeration

      assert.equal(sentEmails.length, 2);
      assert.equal(sentEmails[1].to, 'recoverytester@example.com');
      assert.equal(sentEmails[1].type, 'password_reset');

      const resetToken = sentEmails[1].token;

      // 3. Confirm Password Reset
      const confirmRes = await env.json('POST', '/v1/auth/password-reset/confirm', {
        body: { token: resetToken, newPassword: 'newpassword123' },
      });
      assert.equal(confirmRes.status, 204);
      // It should clear the refresh cookie
      assert.ok(confirmRes.headers.get('set-cookie')?.includes('gambit_refresh=;'));

      // 4. Try logging in with old password (should fail)
      const loginOldRes = await env.json('POST', '/v1/auth/login', {
        body: { handle: 'recoverytester', password: 'oldpassword123' },
      });
      assert.equal(loginOldRes.status, 401);

      // 5. Try logging in with new password (should succeed)
      const loginNewRes = await env.json('POST', '/v1/auth/login', {
        body: { handle: 'recoverytester', password: 'newpassword123' },
      });
      assert.equal(loginNewRes.status, 200);
      assert.equal(loginNewRes.body.user.handle, 'recoverytester');

      // 6. Confirm anti-enumeration on non-existent user
      const fakeResetRes = await env.json('POST', '/v1/auth/password-reset/request', {
        body: { handleOrEmail: 'nobody' },
      });
      assert.equal(fakeResetRes.status, 202); // Still 202
      assert.equal(sentEmails.length, 2); // No new email sent

    } finally {
      await env.close();
    }
  });

  it('rejects expired reset tokens and revokes pre-reset refresh tokens', async () => {
    const env = await startHarness();
    try {
      const reg = await env.json('POST', '/v1/auth/register', {
        body: { handle: 'resetsec', password: 'oldpassword123', email: 'resetsec@example.com' },
      });
      assert.equal(reg.status, 201);
      const preResetRefreshToken = reg.body.tokens.refreshToken;

      // Expired token: request a reset, jump past the 30-minute TTL, confirm fails.
      await env.json('POST', '/v1/auth/password-reset/request', {
        body: { handleOrEmail: 'resetsec' },
      });
      const expiredToken = env.emailSender.sent.find((m) => m.type === 'password_reset')!.token;
      env.clock.advance(31 * 60 * 1000);
      const expiredRes = await env.json('POST', '/v1/auth/password-reset/confirm', {
        body: { token: expiredToken, newPassword: 'newpassword456' },
      });
      assert.equal(expiredRes.status, 401);

      // Fresh token: the reset succeeds…
      await env.json('POST', '/v1/auth/password-reset/request', {
        body: { handleOrEmail: 'resetsec' },
      });
      const freshToken = env.emailSender.sent
        .filter((m) => m.type === 'password_reset')
        .at(-1)!.token;
      const okRes = await env.json('POST', '/v1/auth/password-reset/confirm', {
        body: { token: freshToken, newPassword: 'newpassword456' },
      });
      assert.equal(okRes.status, 204);

      // …and the refresh token issued BEFORE the reset is dead, not just the
      // password: an attacker holding a stolen session cannot survive a reset.
      const refreshRes = await env.json('POST', '/v1/auth/refresh', {
        body: { refreshToken: preResetRefreshToken },
      });
      assert.equal(refreshRes.status, 401, 'pre-reset refresh token must be revoked');
    } finally {
      await env.close();
    }
  });

  it('rejects registration reusing an existing email', async () => {
    const env = await startHarness();
    try {
      const first = await env.json('POST', '/v1/auth/register', {
        body: { handle: 'emailowner', password: 'password123', email: 'owner@example.com' },
      });
      assert.equal(first.status, 201);
      const dup = await env.json('POST', '/v1/auth/register', {
        body: { handle: 'emailthief', password: 'password123', email: 'owner@example.com' },
      });
      assert.equal(dup.status, 409);
    } finally {
      await env.close();
    }
  });
});
