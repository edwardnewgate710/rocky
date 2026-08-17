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

/**
 * Whether this deployment serves engine analysis.
 *
 * Pure, and separately tested, for the same reason `routesToRemove` is: the fetch above is memoised
 * for the page's lifetime with deliberately no reset seam, so a test cannot vary the answer twice in
 * one process. The decision is the part worth covering exhaustively, and it does not need the fetch.
 *
 * **Only an explicit `true` enables it.** A missing key, a non-boolean, a null, or a failed request
 * all mean "not answered", and an unanswered question must not surface a control whose every request
 * would answer 503. This is the opposite default from `routesToRemove`, which removes only on an
 * explicit `false` — and deliberately so: there the cost of guessing wrong is hiding a link that
 * works, here it is offering a button that cannot.
 */
export function analysisEnabled(payload: unknown): boolean {
  return capabilityFlags(payload)?.['analysis'] === true;
}

/**
 * The `capabilities` sub-object of a capabilities response, or `undefined` when the payload is not
 * one.
 *
 * The response has two levels — the boolean flags under `capabilities`, and response-level detail
 * beside them such as `analysisVariants` — and the memo below holds the whole thing. An earlier
 * version memoised only the flags, which is why the variant list arrived as `undefined` at every
 * reader that wanted it: the field was on the response, and the response had already been discarded.
 * The predicate looked correct in isolation and was reading something that could never be there.
 */
export function capabilityFlags(payload: unknown): Record<string, unknown> | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const flags = (payload as { capabilities?: unknown }).capabilities;
  if (flags === null || typeof flags !== 'object') return undefined;
  return flags as Record<string, unknown>;
}

/**
 * Whether this deployment can analyse a specific variant.
 *
 * `analysisEnabled` answers the deployment-wide question; this answers the one that decides whether
 * to offer the control on *this* game. Only engines with a configured binary are registered
 * server-side (ADR-0113), so an image carrying Stockfish alone reports the feature on while
 * answering 422 for Atomic, Crazyhouse, King of the Hill, Three-Check, Horde and Racing Kings.
 *
 * A server predating the field omits it, and the honest reading of a missing list is "not answered"
 * rather than "nothing supported" — so the control stays available and the request-time rejection
 * remains the backstop. That is the one place failing open is right here: the alternative silently
 * removes a working feature from every variant on an older deployment.
 */
export function analysisSupportsVariant(payload: unknown, variant: string | null): boolean {
  if (!analysisEnabled(payload) || variant === null) return false;
  const variants = (payload as { analysisVariants?: unknown } | null)?.analysisVariants;
  if (!Array.isArray(variants)) return true;
  return variants.includes(variant);
}

/**
 * The deployment's capability flags, fetched at most once per page.
 *
 * Exported because the nav is no longer the only consumer: the game route's analysis panel asks the
 * same question, and a second unmemoised caller would reintroduce exactly the per-navigation refetch
 * the memo above exists to prevent — `bootstrap(document)` re-runs on every SPA navigation and every
 * `popstate`, so "once per mount" is once per in-app click.
 *
 * Resolves to the **whole response**, or `null` when the request failed. Not just its `capabilities`
 * sub-object: `analysisVariants` sits beside the flags, and extracting only the flags discarded it
 * before any reader could see it. Callers use `capabilityFlags` to reach the booleans and read
 * response-level fields directly; this never throws.
 */
export async function loadCapabilities(api: GambitClient): Promise<unknown> {
  capabilitiesOnce ??= api
    .capabilities()
    .then((res) => res ?? null)
    .catch(() => null);
  return capabilitiesOnce;
}

export async function applyNavCapabilities(doc: Document, api: GambitClient): Promise<void> {
  for (const route of routesToRemove(capabilityFlags(await loadCapabilities(api)))) {
    for (const link of doc.querySelectorAll(`nav a[data-route="${route}"]`)) {
      link.remove();
    }
  }
}
