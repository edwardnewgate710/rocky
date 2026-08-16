/**
 * Contract tests for the counter reader both operational harnesses share
 * (`scripts/lib/prometheus-text.mjs`).
 *
 * `scripts/ws-load-test.mjs` (ADR-0111) and `scripts/chaos-test.mjs` (ADR-0077) both prove commands
 * crossed between gateway nodes by reading `gateway_forwarded_commands_total`, so every way that
 * read can return the wrong number is a way either harness reports a forwarding proof it never had.
 * The reader is a pure function and is exercised as one; the chaos suite itself needs a two-node
 * stack, and neither harness can be imported without starting a run.
 *
 * They live under `deploy/load/test/` because that is what `npm run test:load-harness` runs in CI,
 * which is the gate this reader has to pass through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readPrometheusCounter } from '../../../scripts/lib/prometheus-text.mjs';

const FORWARDED = 'gateway_forwarded_commands_total';

/** A gateway scrape as it would look once neighbours are added on the same stem. */
const exposition = [
  '# HELP gateway_forwarded_commands_total Commands forwarded to the owning node',
  '# TYPE gateway_forwarded_commands_total counter',
  'gateway_forwarded_commands_total_extra 200',
  'gateway_forward_latency_seconds_bucket{le="0.1"} 99',
  'gateway_forwarded_commands_total 16',
  'gateway_forwarded_commands_total_sum 41',
  '',
].join('\n');

test('the counter is read exactly, never a prefixed neighbour scraped before it', () => {
  assert.equal(
    readPrometheusCounter(exposition, FORWARDED),
    16,
    'a reader that accepted prefixes would answer 200 (the first neighbour) or 257 (their sum), ' +
      'and the chaos suite would call a number that counts nothing a forwarding proof',
  );
});

test('a counter the scrape does not carry is absent, even when its prefixed neighbours are', () => {
  const neighboursOnly = [
    'gateway_forwarded_commands_total_extra 200',
    'gateway_forwarded_commands_total_sum 41',
  ].join('\n');

  assert.equal(
    readPrometheusCounter(neighboursOnly, FORWARDED),
    null,
    'the metric surface changed under the harnesses; reporting a neighbour here would hide that',
  );
  assert.equal(readPrometheusCounter(exposition, 'gateway_missing_total'), null);
  assert.equal(readPrometheusCounter('', FORWARDED), null);
});

test('a same-name labelled family is absent, not whichever series was scraped first', () => {
  const labelled = [
    '# TYPE gateway_forwarded_commands_total counter',
    'gateway_forwarded_commands_total{node="node1"} 9',
    'gateway_forwarded_commands_total{node="node2"} 7',
  ].join('\n');

  assert.equal(
    readPrometheusCounter(labelled, FORWARDED),
    null,
    'the counter gained label dimensions the harnesses never agreed how to add up; answering 9 ' +
      'would let one series that happens to be growing pass as the whole counter',
  );
});

test('a sample carrying no finite number is absent rather than a NaN no comparison can order', () => {
  for (const value of ['nonsense', 'NaN', '+Inf', '']) {
    assert.equal(
      readPrometheusCounter(`${FORWARDED} ${value}`, FORWARDED),
      null,
      `"${value}" must not reach a caller as a number: every comparison against NaN is false, ` +
        'which is the direction that turns a failing forwarding proof into a passing one',
    );
  }
});
