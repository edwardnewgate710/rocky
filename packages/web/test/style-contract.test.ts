import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Two levels up: the suite runs from `dist-test/test/`, not from source. Same as `a11y.test.ts`.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CSS = readFileSync(resolve(PACKAGE_ROOT, 'src/style.css'), 'utf8');

interface Rule {
  readonly selectors: readonly string[];
  readonly body: string;
}

/** Every top-level rule in the stylesheet, comments stripped. */
function rules(): Rule[] {
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  for (const chunk of stripped.split('}')) {
    const brace = chunk.indexOf('{');
    if (brace === -1) continue;
    const head = chunk.slice(0, brace).trim();
    if (!head || head.startsWith('@')) continue;
    out.push({ selectors: head.split(',').map((s) => s.trim()).filter(Boolean), body: chunk.slice(brace + 1) });
  }
  return out;
}

const USES_BACKGROUND_SHORTHAND = /(^|[;\s])background\s*:/;

/**
 * Whether a selector can match a promotion-choice button. That element is
 * `<button class="cb-promo-choice cb-p-wq">`, so both a bare `button` selector and anything naming
 * `.cb-promo-choice` reach it — unless the selector explicitly excludes it.
 */
function canMatchPromoChoice(selector: string): boolean {
  if (selector.includes(':not(.cb-promo-choice)')) return false;
  const compound = selector.split(/\s+|>|\+|~/).filter(Boolean).pop() ?? '';
  return /^button([:.[]|$)/.test(compound) || compound.includes('.cb-promo-choice');
}

/**
 * The promotion picker draws its pieces with the shared `.cb-p-*` classes, which supply only a
 * `background-image`. Any rule matching the button that uses the `background` **shorthand** resets
 * that image to none, and the piece disappears.
 *
 * It happened twice, in two different ways, which is why this test asserts a property of the whole
 * stylesheet rather than of two named rules:
 *
 * 1. `.cb-promo-choice` set `background: var(--promo-tile)`. At equal specificity to `.cb-p-*` and
 *    later in the file, it won — so the dialog rendered four identical blank tiles.
 * 2. `button:not(:disabled):hover` set `background: var(--panel)`. At (0,2,1) it outranks `.cb-p-*`
 *    at (0,1,0), so the piece vanished on hover. The first version of this test missed it entirely,
 *    because it inspected the rules it knew the names of rather than every rule that can match the
 *    element. Found in the review of PR #98.
 *
 * Nothing else catches either one: the markup, the classes and the DOM are all correct, and the only
 * evidence is on screen. Collapsing several `background-*` declarations into one shorthand also looks
 * like a tidy-up, which is what makes it the likeliest regression here.
 */
test('no rule that can match a promotion tile uses the background shorthand', () => {
  const offenders: string[] = [];
  for (const rule of rules()) {
    if (!USES_BACKGROUND_SHORTHAND.test(rule.body)) continue;
    for (const selector of rule.selectors) {
      if (canMatchPromoChoice(selector)) offenders.push(selector);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these rules match a promotion tile and use the background shorthand, which erases the piece: ${offenders.join(', ')}`,
  );
});

/** The rule the artwork actually depends on still has to set the colour it replaced. */
test('the promotion tile sets background-color at rest and on hover', () => {
  for (const selector of ['.cb-promo-choice', '.cb-promo-choice:hover']) {
    const rule = rules().find((r) => r.selectors.includes(selector));
    assert.ok(rule, `no rule found for ${selector}`);
    assert.ok(rule!.body.includes('background-color:'), `${selector} must set background-color`);
  }
});

/**
 * The artwork also needs sizing. `.cb-piece` carries that for pieces on the board, and the promotion
 * button is not a `.cb-piece`, so without these the SVG renders at its intrinsic size, anchored
 * top-left, and tiled.
 */
test('the promotion tile sizes and centres its piece artwork', () => {
  const rule = rules().find((r) => r.selectors.includes('.cb-promo-choice'));
  assert.ok(rule, 'no rule found for .cb-promo-choice');
  for (const declaration of ['background-size:', 'background-repeat:', 'background-position:']) {
    assert.ok(rule!.body.includes(declaration), `.cb-promo-choice must set ${declaration}`);
  }
});
