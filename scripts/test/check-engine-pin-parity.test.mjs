/**
 * Tests for the Stockfish pin parity guard.
 *
 * The guard's whole value is failing on a *partial* upgrade, so these drive each location out of
 * step on its own and require a clear failure. Synthetic text throughout — the real files are
 * covered by the guard itself running in CI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readPin, comparePins, PIN_LOCATIONS } from '../check-engine-pin-parity.mjs';

const DIGEST = 'efca1c60ec11fd9628425f3ee40644ad1618535ddf881c16385a86f7fc9e0983';
const OTHER = '0000000000000000000000000000000000000000000000000000000000000000';
const BINARY = '4350672d7314ad71965affc31fb46cebfbebfe6288083188b62aa3a79f8b4b23';
const FAIRY = 'ab6b85823152e78654092dc2fbb154956a559c6ef0455d728268544390ee150f';

/** The four shapes the pin is written in, one per real location. */
const workflow = (digest = DIGEST, release = 'sf_16') =>
  [
    '      - name: Install Stockfish',
    '        env:',
    `          STOCKFISH_SHA256: ${digest}`,
    '        run: |',
    `          curl -sSL --fail -o /tmp/stockfish.tar https://github.com/official-stockfish/Stockfish/releases/download/${release}/stockfish-ubuntu-x86-64.tar`,
    '      - name: Install Fairy-Stockfish',
    '        env:',
    `          FAIRY_SHA256: ${FAIRY}`,
    '        run: |',
    '          curl -sSL --fail -o /tmp/fairy-stockfish https://github.com/fairy-stockfish/Fairy-Stockfish/releases/download/fairy_sf_14/fairy-stockfish_x86-64',
  ].join('\n');

const dockerfile = (digest = DIGEST, release = 'sf_16') =>
  [
    'FROM node:22-slim AS stockfish',
    'RUN set -eux; \\',
    `    curl -sSL --fail -o /tmp/stockfish.tar https://github.com/official-stockfish/Stockfish/releases/download/${release}/stockfish-ubuntu-x86-64.tar; \\`,
    `    echo "${digest}  /tmp/stockfish.tar" | sha256sum --check --strict -`,
  ].join('\n');

const adr = (digest = DIGEST, release = 'sf_16') =>
  [
    '| release | asset | SHA-256 |',
    '| --- | --- | --- |',
    `| \`${release}\` | \`stockfish-ubuntu-x86-64.tar\` | \`${digest}\` |`,
    '',
    'The executable it contains, `stockfish/stockfish-ubuntu-x86-64`, is',
    `\`${BINARY}\`; recorded for identification but not separately checked.`,
  ].join('\n');

const pin = (label, text) => readPin({ label, file: `${label}.txt`, text });

test('the four locations agree when nothing has drifted', () => {
  const pins = [
    pin('ci', workflow()),
    pin('api', dockerfile()),
    pin('gateway', dockerfile()),
    pin('adr', adr()),
  ];
  for (const other of pins.slice(1)) assert.deepEqual(comparePins(pins[0], other), []);
});

test('a digest changed in one image alone is caught', () => {
  // The partial upgrade this guard exists for: CI and the docs move, one image does not.
  const differences = comparePins(pin('ci', workflow()), pin('api', dockerfile(OTHER)));
  assert.equal(differences.length, 1);
  assert.match(differences[0], /digest/);
});

test('a digest changed in the gateway alone is caught', () => {
  const differences = comparePins(pin('ci', workflow()), pin('gateway', dockerfile(OTHER)));
  assert.match(differences[0], /digest/);
});

test('a digest changed in CI alone is caught', () => {
  // Reference-side drift: CI upgraded, images left behind — the exact state Increment 12 fixed.
  const reference = pin('ci', workflow(OTHER));
  for (const other of [pin('api', dockerfile()), pin('gateway', dockerfile()), pin('adr', adr())]) {
    assert.match(comparePins(reference, other)[0] ?? '', /digest/, `${other.label} must disagree`);
  }
});

test('a digest changed in the documentation alone is caught', () => {
  const differences = comparePins(pin('ci', workflow()), pin('adr', adr(OTHER)));
  assert.match(differences[0], /digest/);
});

test('a release bumped while the digest goes stale is caught', () => {
  // The dangerous half-edit: the tag moves, the digest does not. Without the release comparison
  // this would pass, and CI would be downloading a different engine than the images.
  const differences = comparePins(pin('ci', workflow(DIGEST, 'sf_17')), pin('api', dockerfile()));
  assert.equal(differences.length, 1);
  assert.match(differences[0], /release `sf_16` vs `sf_17`/);
});

test('a differently-built asset of the same release is caught', () => {
  // `-avx2` and `-modern` are the same size as the baseline build, so only the name and the digest
  // separate them. Both are compared.
  const avx2 = dockerfile().replace(/stockfish-ubuntu-x86-64\.tar/g, 'stockfish-ubuntu-x86-64-avx2.tar');
  const differences = comparePins(pin('ci', workflow()), pin('api', avx2));
  assert.ok(differences.some((d) => /asset/.test(d)), `expected an asset difference, got ${differences}`);
});

test("Fairy's digest is not mistaken for Stockfish's", () => {
  // `ci.yml` pins both engines. Reading the wrong one would make every comparison meaningless.
  assert.equal(pin('ci', workflow()).digest, DIGEST);
});

test("the ADR's binary digest is not mistaken for the archive's", () => {
  // ADR-0121 records both. Only the archive digest is the pin the other files carry.
  assert.equal(pin('adr', adr()).digest, DIGEST);
});

test('a location with no pin at all fails loudly rather than being skipped', () => {
  assert.throws(() => pin('empty', 'nothing to see here'), /names no Stockfish release/);
  assert.throws(
    () => pin('nodigest', 'downloads sf_16 stockfish-ubuntu-x86-64.tar somehow'),
    /names no Stockfish archive SHA-256/,
  );
});

test('two conflicting digests inside one file fail rather than the first one winning', () => {
  // A half-finished edit inside a single file is a disagreement too, and reporting only the first
  // match would hide it.
  const half = `${dockerfile()}\n    echo "${OTHER}  /tmp/stockfish.tar"`;
  assert.throws(() => pin('half-edited', half), /conflicting digests/);
});

test('a future upgrade is not blocked by the ADR keeping its history', () => {
  // The guard read the whole ADR, which already names `sf_16` five times. Upgrading to `sf_17` would
  // add the new release and rightly leave the old sentences in place — and the guard would then see
  // two releases and refuse the very change it exists to keep consistent. Scoped to the Decision
  // table row, only the current pin is read. Raised in the Qodo review of PR #143.
  const upgraded = [
    '# 121. Deterministic Engine Installation',
    '',
    'Historically this pinned `sf_16`, whose archive was',
    `\`${DIGEST}\`, and the images installed Debian's package before that.`,
    '',
    '| release | asset | SHA-256 |',
    '| --- | --- | --- |',
    `| \`sf_17\` | \`stockfish-ubuntu-x86-64.tar\` | \`${OTHER}\` |`,
    '',
    'Superseding the `sf_16` pin described above; `sf_16` remains named for the record.',
  ].join('\n');

  const scope = PIN_LOCATIONS.find((l) => l.label === 'ADR-0121').scope;
  const read = readPin({ label: 'ADR-0121', file: 'adr.md', text: upgraded, scope });
  assert.equal(read.release, 'sf_17', 'the table row is the current pin');
  assert.equal(read.digest, OTHER);
});

test('a superseded pin row left above the current one is rejected, not silently preferred', () => {
  // The scoping above must not become a way to read a stale pin. An upgrade that adds the `sf_17`
  // row while leaving the `sf_16` row in the table is the drift this guard exists for, and reading
  // only the first match would take the superseded row and call the file consistent. Raised in the
  // CodeRabbit review of PR #143.
  const bothRows = [
    '| release | asset | SHA-256 |',
    '| --- | --- | --- |',
    `| \`sf_16\` | \`stockfish-ubuntu-x86-64.tar\` | \`${DIGEST}\` |`,
    `| \`sf_17\` | \`stockfish-ubuntu-x86-64.tar\` | \`${OTHER}\` |`,
  ].join('\n');

  const scope = PIN_LOCATIONS.find((l) => l.label === 'ADR-0121').scope;
  assert.throws(
    () => readPin({ label: 'ADR-0121', file: 'adr.md', text: bothRows, scope }),
    /names 2 releases \(sf_16, sf_17\)/,
  );
});

test('a pin row repeated verbatim is not a disagreement', () => {
  // The fix for the case above is to read every matching row, not to refuse more than one: a table
  // that states the same pin twice has not drifted, and failing it would be a guard crying wolf
  // over a documentation edit.
  const repeated = [
    `| \`sf_16\` | \`stockfish-ubuntu-x86-64.tar\` | \`${DIGEST}\` |`,
    '',
    'Restated in the amendment below:',
    '',
    `| \`sf_16\` | \`stockfish-ubuntu-x86-64.tar\` | \`${DIGEST}\` |`,
  ].join('\n');

  const scope = PIN_LOCATIONS.find((l) => l.label === 'ADR-0121').scope;
  const read = readPin({ label: 'ADR-0121', file: 'adr.md', text: repeated, scope });
  assert.equal(read.release, 'sf_16');
  assert.equal(read.digest, DIGEST);
});

test('a scoped location whose region disappears fails loudly', () => {
  // The scoping must not become a way to quietly stop checking: if the table is restructured away,
  // that is a guard that needs teaching, not a pass.
  const scope = PIN_LOCATIONS.find((l) => l.label === 'ADR-0121').scope;
  assert.throws(
    () => readPin({ label: 'ADR-0121', file: 'adr.md', text: 'prose about sf_16 and nothing else', scope }),
    /no longer contains the region/,
  );
});

test('every location the guard claims to read is a real file', () => {
  // Pins the list against the tree, so a rename breaks this rather than the CI job.
  for (const location of PIN_LOCATIONS) {
    assert.doesNotThrow(() => readPin(location), `${location.label} (${location.file})`);
  }
});
