-- Migration 0008 — WebAuthn (passkeys) identity hardening
-- See docs/adr/0027-webauthn-passkeys.md

ALTER TABLE webauthn_credentials ADD COLUMN name TEXT;
UPDATE webauthn_credentials SET name = 'Passkey' WHERE name IS NULL;
ALTER TABLE webauthn_credentials ALTER COLUMN name SET NOT NULL;

CREATE TABLE webauthn_login_challenges (
  challenge_hash TEXT PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE identity_tokens DROP CONSTRAINT identity_tokens_kind_check;
ALTER TABLE identity_tokens ADD CONSTRAINT identity_tokens_kind_check CHECK (kind IN ('password_reset', 'email_verify', 'webauthn_register'));
