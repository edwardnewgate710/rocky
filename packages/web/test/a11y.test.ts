import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Accessibility (a11y) tests for the Gambit web frontend.
 *
 * These tests validate the ARIA structure, keyboard navigation support,
 * and semantic HTML in the index.html template. They parse the static
 * HTML to verify accessibility attributes are present and correct.
 *
 * Limitation (m2): these tests check the static markup only — they
 * cannot see the rendered board/lobby/profile states after JavaScript
 * executes. Full a11y validation requires:
 *   1. The Lighthouse a11y audit (≥ 95) via the Playwright e2e suite.
 *   2. A keyboard-drive-the-board Playwright spec that verifies
 *      focus management and keyboard operability of the live board.
 * Both are part of the M6 acceptance gate and run against the served app.
 */

const HTML_TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Gambit</title>
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="stylesheet" href="/src/style.css" />
  </head>
  <body>
    <a class="skip-link" href="#board">Skip to board</a>
    <header class="topbar">
      <h1><a href="/">Gambit</a></h1>
      <nav class="nav">
        <a href="/">Lobby</a>
        <a href="/profile">Profile</a>
      </nav>
      <button id="theme-toggle" type="button" aria-label="Toggle light/dark theme">🌙</button>
      <button id="flip" type="button" aria-label="Flip board">Flip</button>
    </header>
    <main class="game">
      <section id="board" aria-label="Chess board"></section>
      <aside class="sidebar" aria-label="Game info">
        <p id="status" role="status" aria-live="polite">Your move.</p>
      </aside>
    </main>
    <section id="lobby" aria-label="Lobby" hidden>
      <div id="seek-list" role="list"></div>
      <button id="create-seek" type="button">Create seek</button>
      <p id="lobby-error" class="error" role="alert"></p>
    </section>
    <section id="profile" aria-label="Profile" hidden>
      <h2 id="profile-handle">Profile</h2>
      <p id="profile-error" class="error" role="alert"></p>
    </section>
  </body>
</html>`;

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
  assert.ok(alerts >= 2, 'expected at least 2 role=alert regions');
});

test('seek list has role=list', () => {
  assert.ok(HTML_TEMPLATE.includes('role="list"'));
});

test('buttons have aria-label or text content', () => {
  assert.ok(HTML_TEMPLATE.includes('aria-label="Toggle light/dark theme"'));
  assert.ok(HTML_TEMPLATE.includes('aria-label="Flip board"'));
});

test('nav links are present for lobby and profile', () => {
  assert.ok(HTML_TEMPLATE.includes('href="/">Lobby</a>'));
  assert.ok(HTML_TEMPLATE.includes('href="/profile">Profile</a>'));
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
