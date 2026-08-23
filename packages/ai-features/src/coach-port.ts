/**
 * `CoachPort` — the coaching capability, named by what its consumers need.
 *
 * `StudyPartner` and `VoiceCoach` both took the concrete {@link import('./coach.js').Coach} class,
 * which meant a production caller could only satisfy them by constructing another library `Coach` —
 * bypassing the policies the API's `CoachService` applies (ADR-0129). Depending on the class also
 * bound them to every future change to it, when between them they call exactly one method.
 *
 * So this is deliberately one operation wide. It mirrors the library's own signature rather than
 * inventing a new contract, because the library `Coach` is today's only implementation and a port
 * that no implementation satisfies is a worse abstraction than the class it replaced.
 *
 * **The API's `CoachService` does *not* satisfy this port, and should not be made to.** Its
 * `coach(input, onAccepted?)` returns `CoachOutcome`, whose sections are
 * `CoachSection<T> = CoachPresent<T> | CoachOmitted` — a record of *why* a section is absent — while
 * {@link CoachingResponse} carries `T | null`, which cannot distinguish "not applicable" from
 * "withheld" from "unavailable". Its puzzle section is `CoachPuzzleOutcome`, which deliberately
 * omits the solution the library's `Puzzle` carries; projecting one onto the other would mean
 * inventing a move the service is designed never to send. And `onAccepted` is what charges the rate
 * limit, so an adapter that dropped it would spend engine time for free.
 *
 * That is a genuine difference of contract, not of shape. Anything bridging it belongs in
 * `packages/api`, above this port, and would be a new decision rather than a projection — see
 * ADR-0133.
 */

import type { CoachRequest, CoachingResponse } from './coach-types.js';

/**
 * What `StudyPartner` and `VoiceCoach` actually require of a coach.
 *
 * Structural, so the library `Coach` satisfies it by having the method rather than by declaring it
 * — no `implements` clause, no wrapper, no runtime cost.
 */
export interface CoachPort {
  /**
   * Coach a position, and optionally the move just played in it.
   *
   * @param request - the position, variant, move and move list to reason about.
   * @returns every section the implementation could produce; sections it could not are `null`.
   */
  readonly coach: (request: CoachRequest) => Promise<CoachingResponse>;
}
