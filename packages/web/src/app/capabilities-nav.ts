/**
 * Navigation visibility driven by system capabilities (M14 inc 39).
 *
 * A link to a service this deployment does not run is a door onto a wall, so once
 * `GET /v1/capabilities` answers, the links whose capability is `false` are removed.
 *
 * **The links ship visible and are removed, not hidden and revealed.** The reverse was written
 * first, on the reasoning that a control vanishing under the pointer reads as a bug. That reasoning
 * has the cost backwards: revealing on confirmation leaves *every* link the deployment does have
 * missing until a network round-trip completes — on every page load, for every visitor, forever —
 * to spare a moment's flicker on links that lead nowhere and are being deleted anyway. The rare
 * case does not get to tax the common one.
 *
 * It also removes a whole branch. There is no fail-open path to write: when we cannot find out,
 * nothing is removed and the visitor keeps the navigation they already had.
 */

import type { GambitClient } from '../api/client.js';
import type { SystemCapabilities } from '../api/models.js';

/** Mapping from nav link `data-route` attributes to system capability keys. */
export const NAV_CAPABILITY_MAP: Record<string, keyof SystemCapabilities> = {
  courses: 'learning',
  studies: 'studies',
  teams: 'community',
  messages: 'messaging',
};

/**
 * Which nav routes this payload positively says are absent.
 *
 * **Only an explicit `false` removes a link.** Everything else — a missing key, a non-boolean
 * value, an empty object, a null, a body that is not an object at all — means "not answered", and
 * an unanswered question must never cost the visitor a link.
 *
 * The looser check this replaces accepted any object and then read each flag for truthiness, so a
 * 200 carrying `{"capabilities": {}}` looked like "every capability is off" and stripped the whole
 * optional nav. Raised in the review of PR #102. The response body is cast rather than validated
 * (the same property that needed a guard in ADR-0103), so the shape here is a claim, not a fact —
 * this is the trust boundary and it is the only place that has to be careful.
 */
export function routesToRemove(payload: unknown): readonly string[] {
  if (payload === null || typeof payload !== 'object') return [];
  const flags = payload as Record<string, unknown>;
  return Object.entries(NAV_CAPABILITY_MAP)
    .filter(([, capability]) => flags[capability] === false)
    .map(([route]) => route);
}

/**
 * Memoised for the lifetime of the page, because `main.ts` re-runs `bootstrap(document)` on every
 * SPA navigation and every `popstate` — not once per page load, as it first appears. Without this
 * the app would ask for its capabilities again on each in-app click, to redo a DOM pass whose
 * answer cannot have changed. Also raised in the review of PR #102, after this memo was removed on
 * the mistaken belief that bootstrap runs once.
 */
let capabilitiesOnce: Promise<unknown> | null = null;

export async function applyNavCapabilities(doc: Document, api: GambitClient): Promise<void> {
  capabilitiesOnce ??= api
    .capabilities()
    .then((res) => res?.capabilities)
    .catch(() => null);

  for (const route of routesToRemove(await capabilitiesOnce)) {
    for (const link of doc.querySelectorAll(`nav a[data-route="${route}"]`)) {
      link.remove();
    }
  }
}
