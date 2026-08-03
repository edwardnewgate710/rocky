import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Accessibility (a11y) tests for the Gambit web frontend.
 *
 * These tests validate the ARIA structure, keyboard navigation support,
 * and semantic HTML in the real index.html — not a hand-maintained copy.
 * The HTML is read from the source file so that any regression in
 * index.html is caught immediately.
 *
 * Limitation (m2): these tests check the static markup only — they
 * cannot see the rendered board/lobby/profile states after JavaScript
 * executes. Full a11y validation requires:
 *   1. The Lighthouse a11y audit (≥ 95) via the Playwright e2e suite.
 *   2. A keyboard-drive-the-board Playwright spec that verifies
 *      focus management and keyboard operability of the live board.
 * Both are part of the M6 acceptance gate and run against the served app.
 */

// Resolve the package root from this test file's URL.
// Tests compile to dist-test/test/a11y.test.js, so we need to go up
// to the package root and then read index.html from there.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// From dist-test/test/ → package root is ../../
const PACKAGE_ROOT = resolve(__dirname, '..', '..');
const HTML_TEMPLATE = readFileSync(resolve(PACKAGE_ROOT, 'index.html'), 'utf8');

test('html has lang attribute', () => {
  assert.ok(HTML_TEMPLATE.includes('<html lang="en">'));
});

test('skip link is present and points to board', () => {
  assert.ok(HTML_TEMPLATE.includes('class="skip-link"'));
  assert.ok(HTML_TEMPLATE.includes('href="#board"'));
});

test('board section has aria-label', () => {
  assert.ok(HTML_TEMPLATE.includes('aria-label="Chess board"'));
});

test('status has role=status and aria-live=polite', () => {
  assert.ok(HTML_TEMPLATE.includes('role="status"'));
  assert.ok(HTML_TEMPLATE.includes('aria-live="polite"'));
});

test('error regions have role=alert', () => {
  const alerts = (HTML_TEMPLATE.match(/role="alert"/g) || []).length;
  assert.ok(alerts >= 3, 'expected at least 3 role=alert regions (auth, lobby, profile)');
});

test('seek list has role=list', () => {
  assert.ok(HTML_TEMPLATE.includes('role="list"'));
});

test('buttons have aria-label or text content', () => {
  assert.ok(HTML_TEMPLATE.includes('aria-label="Toggle light/dark theme"'));
  assert.ok(HTML_TEMPLATE.includes('aria-label="Flip board"'));
  assert.ok(HTML_TEMPLATE.includes('aria-label="Sign out"'));
});

test('nav links are present for lobby and profile', () => {
  assert.ok(HTML_TEMPLATE.includes('href="/" data-route="lobby">Lobby</a>'));
  assert.ok(HTML_TEMPLATE.includes('href="/profile" data-route="profile">Profile</a>'));
});

test('viewport meta tag is present for mobile', () => {
  assert.ok(HTML_TEMPLATE.includes('name="viewport"'));
  assert.ok(HTML_TEMPLATE.includes('width=device-width'));
});

test('manifest link is present for PWA', () => {
  assert.ok(HTML_TEMPLATE.includes('rel="manifest"'));
});

test('theme-color meta is present', () => {
  assert.ok(HTML_TEMPLATE.includes('name="theme-color"'));
});

test('hidden sections use hidden attribute (not display:none)', () => {
  assert.ok(HTML_TEMPLATE.includes('hidden>'));
});

test('all interactive elements are buttons or links (no div onclick)', () => {
  assert.ok(!HTML_TEMPLATE.includes('onclick='));
});

// Auth form a11y checks (R5#2)
test('auth section has aria-label', () => {
  assert.ok(HTML_TEMPLATE.includes('aria-label="Sign in"'));
});

test('auth form inputs have associated labels', () => {
  assert.ok(HTML_TEMPLATE.includes('label for="auth-handle"'));
  assert.ok(HTML_TEMPLATE.includes('label for="auth-password"'));
});

test('auth inputs have autocomplete attributes', () => {
  assert.ok(HTML_TEMPLATE.includes('autocomplete="username"'));
  assert.ok(HTML_TEMPLATE.includes('autocomplete="current-password"'));
});

test('auth status has role=status', () => {
  assert.ok(HTML_TEMPLATE.includes('id="auth-status" role="status"'));
});

test('lobby mounts the create-a-game panel', () => {
  // The create action is the CreateGamePanel (built in JS). Its trigger is
  // gated at runtime — disabled with a "Sign in to create a seek" title until
  // authenticated — which the Playwright/Lighthouse suite exercises live.
  assert.ok(HTML_TEMPLATE.includes('id="create-game"'));
});

test('lobby mounts the play vs computer dialog', () => {
  assert.ok(HTML_TEMPLATE.includes('id="play-bot-mount"'));
});

// --- Social region (M10 inc 9) ---

test('every social list region carries an aria-label', () => {
  // Six lists sit on one page with visually similar rows; without labels a
  // screen-reader user cannot tell followers from blocked players.
  for (const label of [
    'aria-label="Followers"',
    'aria-label="Following"',
    'aria-label="Friend requests received"',
    'aria-label="Friend requests sent"',
    'aria-label="Friends"',
    'aria-label="Blocked players"',
  ]) {
    assert.ok(HTML_TEMPLATE.includes(label), `missing ${label}`);
  }
});

test('social errors are announced', () => {
  assert.match(HTML_TEMPLATE, /id="social-error"[^>]*role="alert"/);
});

test('the viewer-only social block starts hidden', () => {
  // It holds the viewer's own requests, friends and blocks. Rendering it before
  // the controller decides whose profile this is would expose one account's
  // relationships on another account's page.
  assert.match(HTML_TEMPLATE, /id="social-self"[^>]*hidden/);
});
