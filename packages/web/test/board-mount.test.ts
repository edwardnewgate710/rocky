import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountBoard } from '../src/app/board.js';

/**
 * Records listener add/remove calls so a remount can be checked for stacking.
 *
 * There is no DOM in this package's unit tests, and `BoardView` touches very little of the element:
 * two class/attribute setters, `innerHTML`, and the three listeners this is about. A fake covering
 * exactly that is enough, and keeps the assertion on the thing that matters — the net number of
 * live handlers — rather than on a rendered tree Playwright already covers.
 */
function fakeElement() {
  const live = new Map<string, Set<unknown>>();
  let adds = 0;
  let html = '';
  return {
    el: {
      classList: { add: (): void => undefined },
      setAttribute: (): void => undefined,
      set innerHTML(value: string) { html = value; },
      get innerHTML() { return html; },
      getBoundingClientRect: () => ({ width: 512, height: 512, left: 0, top: 0 }),
      addEventListener(type: string, fn: unknown): void {
        adds += 1;
        const set = live.get(type) ?? new Set<unknown>();
        set.add(fn);
        live.set(type, set);
      },
      removeEventListener(type: string, fn: unknown): void {
        live.get(type)?.delete(fn);
      },
    } as unknown as HTMLElement,
    liveCount: (type: string): number => live.get(type)?.size ?? 0,
    totalAdds: (): number => adds,
  };
}

test('remounting a board does not stack listeners on the same element', () => {
  const board = fakeElement();
  const flip = fakeElement();

  // Three mounts onto the same element, as three visits to a board route would do: the elements
  // live in index.html and outlive the route, while `bootstrap` re-runs on every SPA navigation.
  mountBoard({ boardEl: board.el, flipEl: flip.el });
  mountBoard({ boardEl: board.el, flipEl: flip.el });
  const third = mountBoard({ boardEl: board.el, flipEl: flip.el });

  assert.equal(board.liveCount('click'), 1, 'one live click handler after three mounts');
  assert.equal(board.liveCount('pointerdown'), 1, 'one live pointerdown handler after three mounts');
  assert.equal(board.liveCount('keydown'), 1, 'one live keydown handler after three mounts');
  assert.equal(flip.liveCount('click'), 1, 'one live flip handler after three mounts');

  // Sanity: the mounts really did attach each time, so the counts above come from detaching the
  // previous view rather than from never attaching at all.
  assert.equal(board.totalAdds(), 9, 'each mount attaches its three handlers before the previous detaches');

  third.destroy();
  assert.equal(board.liveCount('click'), 0, 'destroy detaches the last view too');
  assert.equal(board.liveCount('keydown'), 0, 'destroy detaches keyboard input too');
  assert.equal(flip.liveCount('click'), 0);
});

function coordinateValues(html: string, kind: 'rank' | 'file'): string[] {
  return [...html.matchAll(new RegExp(`cb-coordinate cb-${kind}[^>]*>([^<]+)<`, 'g'))]
    .map((match) => match[1]!);
}

test('board renders every algebraic coordinate in the current orientation', () => {
  const board = fakeElement();
  const mounted = mountBoard({ boardEl: board.el });

  assert.deepEqual(coordinateValues(board.el.innerHTML, 'rank'), ['8', '7', '6', '5', '4', '3', '2', '1']);
  assert.deepEqual(coordinateValues(board.el.innerHTML, 'file'), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);

  mounted.view.flip();
  assert.deepEqual(coordinateValues(board.el.innerHTML, 'rank'), ['1', '2', '3', '4', '5', '6', '7', '8']);
  assert.deepEqual(coordinateValues(board.el.innerHTML, 'file'), ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a']);
  mounted.destroy();
});
