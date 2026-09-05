import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyRouteSurface } from '../src/app/route-surface.js';
import { parseRoute, routeToPath } from '../src/app/router.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML_TEMPLATE = readFileSync(resolve(PACKAGE_ROOT, 'index.html'), 'utf8');
const CSS = readFileSync(resolve(PACKAGE_ROOT, 'src/style.css'), 'utf8');
const MANIFEST = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'public/manifest.webmanifest'), 'utf8'));

test('shell: brand identity is Rookzen in title, manifest, and topbar brand link', () => {
  assert.ok(HTML_TEMPLATE.includes('<title>Rookzen</title>'), 'title should be Rookzen');
  assert.equal(MANIFEST.name, 'Rookzen');
  assert.equal(MANIFEST.short_name, 'Rookzen');
  assert.match(MANIFEST.description, /chess platform/i);
  assert.match(HTML_TEMPLATE, /<h1[^>]*class="[^"]*brand[^"]*"[^>]*>[\s\S]*?Rookzen[\s\S]*?<\/h1>/);
});

test('shell: topbar brand includes an inline rook emblem SVG', () => {
  assert.match(HTML_TEMPLATE, /class="brand-link"[\s\S]*?<svg[\s\S]*?class="brand-rook"/);
});

test('shell: primary play entry is visible in topbar nav', () => {
  assert.ok(
    HTML_TEMPLATE.includes('href="/" data-route="lobby">Play</a>'),
    'navigation must have a visible Play entry link to lobby',
  );
});

test('shell: approved Burgundy & Stone design tokens are defined in dark-first :root', () => {
  // Palette C tokens
  assert.match(CSS, /--bg\s*:\s*#242224/i, 'Dark neutral #242224 must be the primary dark background');
  assert.match(CSS, /--fg\s*:\s*#E9E4DE/i, 'Stone light #E9E4DE must be the primary text color');
  assert.match(CSS, /--accent\s*:\s*#934A54/i, 'Burgundy #934A54 must be defined as brand action accent');
  assert.match(CSS, /--sel\s*:\s*#C6A0A2/i, 'Dusty rose #C6A0A2 must be the selection/focus ring token on dark');
  assert.match(CSS, /--muted\s*:\s*#A6A6A7/i, 'Silver gray #A6A6A7 must be secondary/muted text token');
  assert.match(CSS, /--dark\s*:\s*#91888B/i, 'Dark stone board square derivative #91888B');
  assert.match(CSS, /--light\s*:\s*#E9E4DE/i, 'Stone light board square #E9E4DE');
});

test('shell: light theme defines proper stone & deep burgundy derivatives', () => {
  assert.match(CSS, /--light-bg\s*:\s*#F5F1ED/i, 'Light stone background derivative #F5F1ED');
  assert.match(CSS, /--light-fg\s*:\s*#242224/i, 'Dark neutral text on light #242224');
  assert.match(CSS, /--sel-deep\s*:\s*#83414B/i, 'Deep burgundy #83414B for light surfaces');
});

test('shell: learn subnavigation connects Courses, Endgame Trainer, and Studies', () => {
  assert.match(HTML_TEMPLATE, /<section id="courses"[\s\S]*?<nav class="subnav"/, 'courses has learn subnav');
  assert.match(HTML_TEMPLATE, /<section id="endgames"[\s\S]*?<nav class="subnav"/, 'endgames has learn subnav');
  assert.match(HTML_TEMPLATE, /<section id="studies"[\s\S]*?<nav class="subnav"/, 'studies has learn subnav');
});

test('shell: 404 not-found route has dedicated surface with return affordance', () => {
  assert.ok(HTML_TEMPLATE.includes('id="not-found"'), 'index.html must have #not-found surface');
  assert.match(HTML_TEMPLATE, /id="not-found"[\s\S]*?Page not found/);
  assert.match(HTML_TEMPLATE, /id="not-found"[\s\S]*?href="\/" data-route="lobby"/);
});

test('shell: not-found route activates #not-found surface and hides game controls', () => {
  const elements = new Map<string, { hidden: boolean }>();
  const ids = ['lobby', 'game-main', 'not-found', 'courses', 'endgames', 'studies', 'flip', 'skip-board'];
  for (const id of ids) elements.set(id, { hidden: false });
  const bodyClasses = new Set<string>();

  const doc = {
    getElementById: (id: string) => elements.get(id) ?? null,
    body: {
      classList: {
        toggle: (name: string, force: boolean) => {
          if (force) bodyClasses.add(name);
          else bodyClasses.delete(name);
          return force;
        },
      },
    },
  } as unknown as Document;

  applyRouteSurface(doc, { name: 'not-found' });
  assert.equal(elements.get('not-found')?.hidden, false, '#not-found surface should be visible');
  assert.equal(elements.get('lobby')?.hidden, true, '#lobby should be hidden');
  assert.equal(elements.get('game-main')?.hidden, true, '#game-main should be hidden');
  assert.equal(elements.get('flip')?.hidden, true, 'flip button should be hidden');
});

test('shell: font-family includes Source Sans 3 candidate with safe fallbacks', () => {
  assert.match(CSS, /font-family\s*:[^;]*'Source Sans 3'/);
});
