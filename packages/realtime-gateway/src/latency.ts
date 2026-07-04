/**
 * @packageDocumentation
 * Latency compensation helpers.
 *
 * Clocks are authoritative on the server: a move broadcast carries the exact
 * remaining time plus the `serverTs` at which the mover's turn began for the
 * side now on move. Clients render an interpolated countdown corrected by
 * half the measured round-trip time, so the displayed clock tracks the server
 * without ever influencing the authoritative timing (`docs/ARCHITECTURE.md` §4).
 *
 * These functions are pure and shared by clients (and tested here) so the
 * interpolation logic has exactly one implementation.
 */

/** Estimate round-trip time from a ping's send and receive timestamps. */
export function estimateRttMs(pingSentTs: number, pongReceivedTs: number): number {
  return Math.max(0, pongReceivedTs - pingSentTs);
}

/**
 * The one-way clock skew estimate: assuming a symmetric link, the server's
 * clock is ahead of the client's by roughly `serverTs - pingSentTs - rtt/2`.
 */
export function estimateSkewMs(pingSentTs: number, serverTs: number, rttMs: number): number {
  return serverTs - pingSentTs - rttMs / 2;
}

/**
 * Interpolate the remaining time for the side to move.
 *
 * @param remainingMs   Authoritative remaining time when the turn began.
 * @param turnStartServerTs  Server timestamp at which the current turn began.
 * @param nowClientTs   Current client timestamp.
 * @param skewMs        Estimated (serverClock − clientClock); see {@link estimateSkewMs}.
 * @returns Clamped, never-negative remaining milliseconds to display.
 */
export function interpolateRemaining(
  remainingMs: number,
  turnStartServerTs: number,
  nowClientTs: number,
  skewMs = 0,
): number {
  const nowServerTs = nowClientTs + skewMs;
  const elapsed = Math.max(0, nowServerTs - turnStartServerTs);
  return Math.max(0, remainingMs - elapsed);
}
