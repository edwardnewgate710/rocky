/**
 * Reading one counter out of Prometheus text exposition.
 *
 * Shared by `scripts/ws-load-test.mjs` (ADR-0111) and `scripts/chaos-test.mjs` (ADR-0077): both
 * prove commands crossed between gateway nodes by reading `gateway_forwarded_commands_total`, and
 * a proof that reads the wrong number is not a proof. It lives beside `k6-docker.mjs` rather than
 * inside it because reading a counter has nothing to do with running k6 in Docker, and the chaos
 * suite runs no k6.
 */

/**
 * Read one exact, unlabelled counter, or `null` when the exposition carries no readable value
 * under that exact name.
 *
 * The name must match a whole sample name, never a prefix of one. Every metric name is a prefix of
 * the names around it — `gateway_forwarded_commands_total_extra`, and the `_bucket`/`_sum`/`_count`
 * series a histogram on the same stem would add — so a reader that accepted prefixes would report a
 * neighbour's value, or a sum of neighbours, under the name of the counter it was asked for.
 *
 * A sample carrying labels is `null` as well, even under the exact name. Both callers read a
 * counter that has no label dimensions, and a labelled sample means that stopped being true: the
 * value is then one series out of a family, and no caller here has said how a family should be
 * added up. Answering with the first series would let one series that happens to be growing stand
 * in for the whole counter.
 *
 * A value that is not a finite number is `null` too: both callers can only compare numbers, and a
 * NaN silently answers `false` to every comparison, which is the direction that turns a failing
 * proof into a passing one.
 */
export function readPrometheusCounter(exposition, name) {
  for (const line of exposition.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)$/.exec(trimmed);
    if (!match) continue;
    const [, sampleName, labels, sampleValue] = match;
    if (sampleName !== name) continue;
    if (labels !== undefined) return null;
    const value = Number(sampleValue);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}
