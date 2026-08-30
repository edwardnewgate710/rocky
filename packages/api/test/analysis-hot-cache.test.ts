/**
 * The process-local hot tier in front of the durable analysis cache (ADR-0139).
 *
 * Two levels, because the tier makes two different kinds of promise and only one of them is
 * visible from each vantage point.
 *
 * The first half drives `HotAnalysisCache` directly against a counting delegate, which is the only
 * way to assert the things the tier exists for: that a second lookup costs *zero* durable reads,
 * that recency really is promoted, that capacity is never exceeded, and that an entry stops
 * answering when its deadline passes. A real `EngineManager` cannot show any of those — it would
 * report the same "cache hit" either way, which is exactly the blindness the new counters exist to
 * fix.
 *
 * The second half drives a real `EngineManager` over the tier, because the promises that matter
 * most are about what the tier must *not* change: single-flight, cancellation, fail-open, and the
 * rule that only a validated result is ever cached. Those live in `AnalysisOrchestrator`, and the
 * only honest way to show they still hold is to run the real one and count the searches it starts.
 * `FakeEngineTransport` is the engine package's own double, and counting its `go` commands is what
 * makes "the engine did not run again" an assertion rather than a hope.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EngineManager,
  FakeEngineTransport,
  stockfishPlugin,
  type AnalysisCache,
  type AnalysisKey,
  type AnalysisLimits,
  type CacheMeta,
  type EngineResult,
} from '@chess-platform/engine';
import {
  HOT_CACHE_TTL_MS,
  HotAnalysisCache,
  MAX_HOT_CACHE_ENTRIES,
  type HotCacheOutcome,
} from '../src/analysis/hot-cache';
import { analysisCacheSettingsFromEnv } from '../src/analysis/composition';
import { AnalysisCacheObservability } from '../src/analysis/cache-observability';
import { JsonLogger } from '../src/ports/logger';
import { InMemoryMetrics } from '../src/ports/metrics';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function key(overrides: Partial<AnalysisKey> = {}): AnalysisKey {
  return { fingerprint: 'stockfish-16', fen: FEN, variant: 'standard', multiPv: 1, ...overrides };
}

function results(depth: number): readonly EngineResult[] {
  return [
    {
      multipv: 1,
      evaluation: { type: 'cp', value: 20 },
      principalVariation: ['e2e4'],
      depth,
      nodes: 1_000,
      nps: 5_000,
      timeMs: 100,
    },
  ];
}

/** A durable tier that counts what it was asked and can be told exactly how to answer. */
class CountingDelegate implements AnalysisCache {
  reads = 0;
  writes = 0;
  answer: readonly EngineResult[] | undefined;
  failReadWith: Error | undefined;
  failWriteWith: Error | undefined;

  constructor(answer?: readonly EngineResult[]) {
    this.answer = answer;
  }

  async get(_key: AnalysisKey, _requested: AnalysisLimits): Promise<readonly EngineResult[] | undefined> {
    this.reads += 1;
    if (this.failReadWith) throw this.failReadWith;
    return this.answer;
  }

  async set(_key: AnalysisKey, _value: readonly EngineResult[], _meta: CacheMeta): Promise<void> {
    this.writes += 1;
    if (this.failWriteWith) throw this.failWriteWith;
  }
}

/** A clock the test moves by hand, so every expiry assertion is exact rather than timed. */
class ManualClock {
  private value = 1_000;
  readonly now = (): number => this.value;
  /** Signed, so a test can drive the seam backwards the way an NTP step would a wall clock. */
  advance(ms: number): void {
    this.value += ms;
  }
}

function outcomes(): { observer: { recordHotCache(o: HotCacheOutcome): void }; seen: HotCacheOutcome[] } {
  const seen: HotCacheOutcome[] = [];
  return { observer: { recordHotCache: (o) => seen.push(o) }, seen };
}

// ---------------------------------------------------------------------------
// The tier itself
// ---------------------------------------------------------------------------

test('a cold lookup misses, reads the durable tier, and keeps what it found', async () => {
  const delegate = new CountingDelegate(results(10));
  const { observer, seen } = outcomes();
  const hot = new HotAnalysisCache({ delegate, maxEntries: 10, observer });

  const found = await hot.get(key(), { depth: 10 });

  assert.deepEqual(found, results(10), 'the durable value is returned unchanged');
  assert.equal(delegate.reads, 1, 'a cold key must reach the durable tier');
  assert.equal(hot.size, 1, 'and the durable hit must populate the hot tier');
  assert.deepEqual(seen, ['miss', 'durable_hit'], 'both halves of the lookup are counted');
});

test('a second lookup is answered from memory, with no durable read at all', async () => {
  const delegate = new CountingDelegate(results(10));
  const { observer, seen } = outcomes();
  const hot = new HotAnalysisCache({ delegate, maxEntries: 10, observer });

  await hot.get(key(), { depth: 10 });
  const second = await hot.get(key(), { depth: 10 });

  assert.deepEqual(second, results(10));
  assert.equal(delegate.reads, 1, 'the whole point: the second lookup must not touch PostgreSQL');
  assert.equal(seen.filter((o) => o === 'hit').length, 1);
});

test('a hot hit promotes recency, so the promoted entry survives the next eviction', async () => {
  const delegate = new CountingDelegate();
  const hot = new HotAnalysisCache({ delegate, maxEntries: 2 });

  await hot.set(key({ fen: 'a' }), results(10), { limits: { depth: 10 } });
  await hot.set(key({ fen: 'b' }), results(10), { limits: { depth: 10 } });
  // Touching 'a' makes 'b' the least recently used, so 'b' is what the third insert must evict.
  await hot.get(key({ fen: 'a' }), { depth: 10 });
  await hot.set(key({ fen: 'c' }), results(10), { limits: { depth: 10 } });

  delegate.answer = undefined;
  assert.notEqual(await hot.get(key({ fen: 'a' }), { depth: 10 }), undefined, 'the promoted entry stayed');
  assert.equal(await hot.get(key({ fen: 'b' }), { depth: 10 }), undefined, 'the unpromoted one went');
});

test('insertion evicts the least recently used entry, and counts it', async () => {
  const delegate = new CountingDelegate();
  const { observer, seen } = outcomes();
  const hot = new HotAnalysisCache({ delegate, maxEntries: 2, observer });

  await hot.set(key({ fen: 'a' }), results(10), { limits: { depth: 10 } });
  await hot.set(key({ fen: 'b' }), results(10), { limits: { depth: 10 } });
  await hot.set(key({ fen: 'c' }), results(10), { limits: { depth: 10 } });

  assert.equal(hot.size, 2);
  assert.equal(seen.filter((o) => o === 'evicted').length, 1, 'the eviction is visible to an operator');
  assert.equal(await hot.get(key({ fen: 'a' }), { depth: 10 }), undefined, 'the oldest entry went first');
});

test('eviction gives up an expired entry before a live one', async () => {
  // Deadlines are absolute but promotion is not, so the two orders diverge: a hit moves an entry to
  // the tail without renewing it, and it can expire there while a newer live entry sits at the head.
  // Evicting the head blindly would discard the entry that could still answer.
  const clock = new ManualClock();
  const delegate = new CountingDelegate();
  const { observer, seen } = outcomes();
  const hot = new HotAnalysisCache({ delegate, maxEntries: 2, now: clock.now, observer });

  await hot.set(key({ fen: 'old' }), results(10), { limits: { depth: 10 } }); // deadline t+60s
  clock.advance(50_000);
  await hot.set(key({ fen: 'new' }), results(10), { limits: { depth: 10 } }); // deadline t+110s
  await hot.get(key({ fen: 'old' }), { depth: 10 }); // still live; promoted past 'new'

  clock.advance(15_000); // 'old' is now expired; 'new' is not
  await hot.set(key({ fen: 'third' }), results(10), { limits: { depth: 10 } });

  assert.equal(hot.size, 2);
  assert.notEqual(
    await hot.get(key({ fen: 'new' }), { depth: 10 }),
    undefined,
    'the live entry must survive; only the expired one was dead weight',
  );
  assert.equal(seen.filter((o) => o === 'evicted').length, 0, 'this was expiry, not capacity pressure');
  assert.equal(seen.filter((o) => o === 'expired').length, 1);
});

test('capacity cannot be exceeded, by writes or by durable-hit population', async () => {
  const delegate = new CountingDelegate(results(10));
  const hot = new HotAnalysisCache({ delegate, maxEntries: 3 });

  // Both insertion paths, interleaved, far past the bound. A bound only `set` enforced would show
  // up here as a map several hundred entries deep.
  for (let i = 0; i < 200; i += 1) {
    await hot.set(key({ fen: `w${i}` }), results(10), { limits: { depth: 10 } });
    await hot.get(key({ fen: `r${i}` }), { depth: 10 });
    assert.ok(hot.size <= 3, `capacity exceeded at iteration ${i}: ${hot.size}`);
  }
  assert.equal(hot.size, 3);
});

test('an entry stops answering once its deadline passes, and is not returned', async () => {
  const clock = new ManualClock();
  const delegate = new CountingDelegate(results(10));
  const { observer, seen } = outcomes();
  const hot = new HotAnalysisCache({
    delegate,
    maxEntries: 10,
    now: clock.now,
    observer,
  });

  await hot.get(key(), { depth: 10 });
  assert.equal(delegate.reads, 1);

  clock.advance(59_999);
  await hot.get(key(), { depth: 10 });
  assert.equal(delegate.reads, 1, 'inside the deadline the entry still answers');

  clock.advance(1);
  // The durable tier has since lost the row, which is what makes this assertion about the hot tier
  // rather than about the delegate: if the expired entry were served, this would not be undefined.
  delegate.answer = undefined;
  assert.equal(await hot.get(key(), { depth: 10 }), undefined, 'an expired value is never returned');
  assert.equal(delegate.reads, 2, 'expiry is a miss, so the durable tier is consulted again');
  assert.ok(seen.includes('expired'));
  assert.equal(hot.size, 0, 'and the expired entry is dropped rather than left occupying capacity');
});

test('the deadline is absolute: reading an entry a thousand times does not extend it', async () => {
  const clock = new ManualClock();
  const delegate = new CountingDelegate(results(10));
  const hot = new HotAnalysisCache({ delegate, maxEntries: 10, now: clock.now });

  await hot.get(key(), { depth: 10 });
  // The durable tier goes quiet, so nothing can refill the entry and every later answer must have
  // come from the one insertion above.
  delegate.answer = undefined;

  // A hot position, read once a second for two minutes. A sliding deadline renewed on read would
  // answer all 120 times — which is precisely how a hot tier could outlive the retention policy.
  let served = 0;
  for (let i = 0; i < 120; i += 1) {
    clock.advance(1_000);
    if ((await hot.get(key(), { depth: 10 })) !== undefined) served += 1;
  }

  // Reads land at 1s..120s after insertion; the entry answers exactly those inside the 60s window.
  assert.equal(served, 59, 'constant traffic cannot make an entry immortal');
  assert.equal(hot.size, 0);
});

/**
 * The production clock is monotonic, and that fact has no behavioural assertion available: every
 * test here injects `now`, so swapping `performance.now()` back to `Date.now()` would leave all of
 * them green while quietly making this ADR's "absolute" deadline depend on NTP. The repository
 * already guards this class of invisible change the same way, in `analysis-cache-composition.test.ts`.
 */
test('the production deadline is measured on a monotonic clock', () => {
  const source = readFileSync(
    resolve(__dirname, '..', '..', 'src/analysis/hot-cache.ts'),
    'utf8',
  );
  assert.match(
    source,
    /this\.now\s*=\s*options\.now\s*\?\?\s*\(\(\)\s*=>\s*performance\.now\(\)\)/,
    'the default clock must be monotonic, or a backward wall-clock step extends every live entry',
  );
  assert.doesNotMatch(source, /Date\.now\(\)/, 'no wall-clock reading may reach this tier');
});

test('the deadline holds even when the clock reading moves backwards', async () => {
  // Drives the seam the way an NTP step would drive a wall clock. This is about the expiry
  // comparison being against a fixed deadline rather than an accumulated delta; the test above is
  // what pins the production clock itself.
  const clock = new ManualClock();
  const delegate = new CountingDelegate(results(10));
  const hot = new HotAnalysisCache({ delegate, maxEntries: 10, now: clock.now });

  await hot.get(key(), { depth: 10 });
  delegate.answer = undefined;

  clock.advance(-3_600_000); // an hour backwards, mid-life
  clock.advance(3_600_000 + 60_000); // and forward again, past the deadline

  assert.equal(await hot.get(key(), { depth: 10 }), undefined, 'the deadline still lands');
  assert.equal(hot.size, 0);
});

test('a cached entry does not follow the caller\u2019s limits object if it later changes', async () => {
  // The orchestrator hands `get` the request's own limits object, and a hot entry outlives the call.
  // Aliasing it would let this depth-10 analysis answer a depth-20 lookup — the one direction the
  // tier must never claim.
  const delegate = new CountingDelegate(results(10));
  const hot = new HotAnalysisCache({ delegate, maxEntries: 10 });

  const requested: { depth: number } = { depth: 10 };
  await hot.get(key(), requested);
  requested.depth = 20;

  delegate.answer = undefined;
  assert.equal(
    await hot.get(key(), { depth: 20 }),
    undefined,
    'the entry must still claim only the depth it was stored under',
  );
  assert.equal((await hot.get(key(), { depth: 10 }))?.[0]?.depth, 10, 'and must still answer depth 10');
});

test('a stronger request misses without discarding the weaker entry it could not use', async () => {
  const delegate = new CountingDelegate();
  const hot = new HotAnalysisCache({ delegate, maxEntries: 10 });

  await hot.set(key(), results(10), { limits: { depth: 10 } });

  assert.equal(await hot.get(key(), { depth: 20 }), undefined, 'depth 20 is not answerable from depth 10');
  assert.equal(delegate.reads, 1, 'the request that memory could not serve fell through to the durable tier');

  // The depth-10 entry is still there for every request it *can* answer, which is why the miss above
  // must not delete it. Deleting it would let one deep request cost every shallow one a round trip.
  assert.equal((await hot.get(key(), { depth: 10 }))?.[0]?.depth, 10);
  assert.equal(delegate.reads, 1, 'and answering it cost no second durable read');
  assert.equal(hot.size, 1);
});

test('repeated writes for one key keep the strongest, and never duplicate the entry', async () => {
  const delegate = new CountingDelegate();
  const hot = new HotAnalysisCache({ delegate, maxEntries: 10 });

  await hot.set(key(), results(20), { limits: { depth: 20 } });
  await hot.set(key(), results(10), { limits: { depth: 10 } });

  assert.equal(hot.size, 1, 'one key is one entry, however many times it is written');
  const found = await hot.get(key(), { depth: 20 });
  assert.equal(found?.[0]?.depth, 20, 'a shallower search must not displace a deeper one');

  await hot.set(key(), results(30), { limits: { depth: 30 } });
  assert.equal(hot.size, 1);
  assert.equal((await hot.get(key(), { depth: 30 }))?.[0]?.depth, 30, 'but a deeper one must');
});

test('an expired incumbent does not block its replacement, and is counted as expired', async () => {
  const clock = new ManualClock();
  const { observer, seen } = outcomes();
  const hot = new HotAnalysisCache({
    delegate: new CountingDelegate(),
    maxEntries: 10,
    now: clock.now,
    observer,
  });

  await hot.set(key(), results(20), { limits: { depth: 20 } });
  clock.advance(60_000);
  // Dominance is read against *live* entries only. Checked the other way round, this weaker write
  // would be refused by a deep entry that is already past its deadline — leaving the key holding a
  // value nothing may serve and nothing may replace.
  await hot.set(key(), results(10), { limits: { depth: 10 } });

  assert.equal((await hot.get(key(), { depth: 10 }))?.[0]?.depth, 10);
  // A replacement is the third way an entry can leave for its deadline, alongside a read that finds
  // it dead and an eviction that gives it up first. Counting only the first two would make `expired`
  // understate TTL pressure by however much of the traffic happens to be writes.
  assert.equal(seen.filter((o) => o === 'expired').length, 1);
  assert.equal(seen.filter((o) => o === 'evicted').length, 0, 'this was not capacity pressure');
});

test('distinct identities do not collide', async () => {
  const delegate = new CountingDelegate();
  const hot = new HotAnalysisCache({ delegate, maxEntries: 100 });

  const identities: readonly AnalysisKey[] = [
    key(),
    key({ fingerprint: 'stockfish-17' }),
    key({ variant: 'atomic' }),
    key({ multiPv: 3 }),
    key({ fen: `${FEN} ` }),
  ];
  for (const [index, identity] of identities.entries()) {
    await hot.set(identity, results(10 + index), { limits: { depth: 10 + index } });
  }

  assert.equal(hot.size, identities.length, 'each identity is its own entry');
  for (const [index, identity] of identities.entries()) {
    const found = await hot.get(identity, { depth: 10 + index });
    assert.equal(found?.[0]?.depth, 10 + index, `identity ${index} returned another identity's analysis`);
  }
});

test('a durable tier that rejects a payload leaves the hot tier empty', async () => {
  // `PgAnalysisCache` turns an undecodable row into `undefined` rather than a guess, so this is the
  // exact shape a corrupt or future-versioned payload takes by the time it reaches this tier. There
  // is nothing to cache, and nothing must be cached.
  const delegate = new CountingDelegate(undefined);
  const hot = new HotAnalysisCache({ delegate, maxEntries: 10 });

  assert.equal(await hot.get(key(), { depth: 10 }), undefined);
  assert.equal(hot.size, 0, 'a miss must never become an entry');
});

test('a durable read failure travels through untouched, so fail-open stays where it is', async () => {
  const delegate = new CountingDelegate(results(10));
  delegate.failReadWith = new Error('connection terminated');
  const hot = new HotAnalysisCache({ delegate, maxEntries: 10 });

  // Absorbing this here would move the fail-open boundary and change which counter an outage
  // increments. The orchestrator owns that catch; this tier must not add a second one.
  await assert.rejects(hot.get(key(), { depth: 10 }), /connection terminated/);
  assert.equal(hot.size, 0);
});

test('a durable write failure still leaves the value in memory', async () => {
  const delegate = new CountingDelegate();
  delegate.failWriteWith = new Error('pool has ended');
  const hot = new HotAnalysisCache({ delegate, maxEntries: 10 });

  await assert.rejects(hot.set(key(), results(10), { limits: { depth: 10 } }), /pool has ended/);
  // This is the whole argument for populating memory before delegating: a database outage costs the
  // durable row, and must not also cost the in-process hit that would have softened it.
  assert.equal((await hot.get(key(), { depth: 10 }))?.[0]?.depth, 10);
  assert.equal(delegate.reads, 0);
});

test('cached results are frozen on both insertion paths', async () => {
  // Both paths, because a hot entry is shared by every later reader and the two paths reach `store`
  // from different callers — freezing only what `set` writes would leave everything the durable tier
  // supplied mutable, which is the larger half of the traffic on a cold process.
  const fromWrite = new HotAnalysisCache({ delegate: new CountingDelegate(), maxEntries: 10 });
  await fromWrite.set(key(), results(10), { limits: { depth: 10 } });

  const fromDurable = new HotAnalysisCache({ delegate: new CountingDelegate(results(10)), maxEntries: 10 });
  await fromDurable.get(key(), { depth: 10 });

  for (const [label, hot] of [['set', fromWrite], ['durable hit', fromDurable]] as const) {
    const found = await hot.get(key(), { depth: 10 });
    const line = found?.[0];
    assert.ok(Object.isFrozen(found), `${label}: the result set is frozen`);
    assert.ok(Object.isFrozen(line), `${label}: and each line`);
    assert.ok(Object.isFrozen(line?.principalVariation), `${label}: and each principal variation`);
    // The most damaging field to corrupt: every caller downstream reads it as the position's score.
    assert.ok(Object.isFrozen(line?.evaluation), `${label}: and the evaluation`);
  }
});

test('an analysis with no lines is never stored, from either direction', async () => {
  // Structurally fine to a `Map` and unusable to every caller. Neither production path can produce
  // one, so this asserts the guard rather than a scenario.
  const delegate = new CountingDelegate([]);
  const hot = new HotAnalysisCache({ delegate, maxEntries: 10 });

  await hot.get(key(), { depth: 10 });
  assert.equal(hot.size, 0, 'a durable tier that somehow returned no lines must not populate memory');

  await hot.set(key(), [], { limits: { depth: 10 } });
  assert.equal(hot.size, 0, 'and neither must a write');
});

test('two overlapping lookups with different limits leave one coherent entry', async () => {
  // The orchestrator single-flights identical (key, limits, priority) tuples, so these two are NOT
  // coalesced and really do interleave across the delegate await. Whichever lands second must not
  // leave the key claiming more than the analysis behind it achieved.
  const delegate = new CountingDelegate(results(30));
  const hot = new HotAnalysisCache({ delegate, maxEntries: 10 });

  const [shallow, deep] = await Promise.all([
    hot.get(key(), { depth: 10 }),
    hot.get(key(), { depth: 20 }),
  ]);

  assert.equal(shallow?.[0]?.depth, 30, 'both callers get the durable value');
  assert.equal(deep?.[0]?.depth, 30);
  assert.equal(hot.size, 1, 'one key is one entry, however many lookups raced');

  // The surviving entry recorded a *requested* depth, never the row's 30. Asking for more than it
  // claims must fall through rather than be answered on a promise it cannot keep.
  delegate.answer = undefined;
  assert.equal(await hot.get(key(), { depth: 30 }), undefined, 'the entry never over-claims');
});

test('a throwing observer cannot take the cache down with it', async () => {
  const hot = new HotAnalysisCache({
    delegate: new CountingDelegate(results(10)),
    maxEntries: 10,
    observer: {
      recordHotCache: () => {
        throw new Error('metrics registry is on fire');
      },
    },
  });

  assert.deepEqual(await hot.get(key(), { depth: 10 }), results(10));
});

test('the tier refuses a capacity it cannot honour', () => {
  const delegate = new CountingDelegate();
  assert.throws(() => new HotAnalysisCache({ delegate, maxEntries: 0 }), RangeError);
  assert.throws(() => new HotAnalysisCache({ delegate, maxEntries: 1.5 }), RangeError);
});

/**
 * There is no way to lengthen the deadline, which is the point: a constructor override would be a
 * route to a hot entry outliving the retention window, and "no production caller passes it" is a
 * convention rather than a guarantee. Asserted at the source, because a re-added option that nothing
 * happens to pass would leave every behavioural test green.
 */
test('the deadline cannot be overridden by a caller', () => {
  const source = readFileSync(resolve(__dirname, '..', '..', 'src/analysis/hot-cache.ts'), 'utf8');
  // The knob, not the word: line 50 names the durable tier's `ttlMs` in prose, which is fine.
  assert.doesNotMatch(source, /readonly ttlMs|this\.ttlMs|options\.ttlMs/, 'no TTL knob may exist');
  assert.match(source, /expiresAt: now \+ HOT_CACHE_TTL_MS/, 'the deadline comes from the constant');
});

test('clear releases everything the tier holds', async () => {
  const delegate = new CountingDelegate();
  const hot = new HotAnalysisCache({ delegate, maxEntries: 10 });
  await hot.set(key(), results(10), { limits: { depth: 10 } });

  hot.clear();

  assert.equal(hot.size, 0);
  assert.equal(await hot.get(key(), { depth: 10 }), undefined, 'a cleared tier answers nothing');
});

test('a lookup parked on the durable tier cannot repopulate after clear', async () => {
  // The orchestrator awaits this tier's `get` before it ever reaches the engine, so a lookup can be
  // sitting on `delegate.get` when shutdown runs. Resuming into `store` would leave entries in a
  // tier that had already reported itself released.
  let release!: (value: readonly EngineResult[]) => void;
  const parked = new Promise<readonly EngineResult[]>((resolve) => {
    release = resolve;
  });
  const delegate: AnalysisCache = {
    get: () => parked,
    set: async () => {},
  };
  const hot = new HotAnalysisCache({ delegate, maxEntries: 10 });

  const lookup = hot.get(key(), { depth: 10 });
  hot.clear();
  release(results(10));
  await lookup;

  assert.equal(hot.size, 0, 'the parked read must not put an entry back');
});

test('the tier starts no timer and holds no handle', async () => {
  // The whole resource list, not just timers: a handle of any kind is a thing that could outlive
  // shutdown, and naming only the one this design was most tempted to create would prove the least.
  const before = process.getActiveResourcesInfo().slice().sort();
  const hot = new HotAnalysisCache({ delegate: new CountingDelegate(results(10)), maxEntries: 2 });

  // Exercise every path that could plausibly have wanted a timer: population, expiry, eviction.
  for (let i = 0; i < 20; i += 1) {
    await hot.set(key({ fen: `f${i}` }), results(10), { limits: { depth: 10 } });
    await hot.get(key({ fen: `f${i}` }), { depth: 10 });
  }

  // Expiry is lazy by design. A sweep timer would be the one way this tier could keep a process
  // alive past shutdown, so its absence is asserted rather than assumed.
  assert.deepEqual(
    process.getActiveResourcesInfo().slice().sort(),
    before,
    'the hot tier must not create a timer, or any other handle',
  );
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test('hot capacity comes from ANALYSIS_CACHE_ENTRIES, defaulted and clamped', () => {
  assert.equal(analysisCacheSettingsFromEnv({}).hotEntries, 500, 'unset means the shared default');
  assert.equal(analysisCacheSettingsFromEnv({ ANALYSIS_CACHE_ENTRIES: '1200' }).hotEntries, 1_200);
  assert.equal(
    analysisCacheSettingsFromEnv({ ANALYSIS_CACHE_ENTRIES: '10000000' }).hotEntries,
    MAX_HOT_CACHE_ENTRIES,
    'an implausible number is clamped, not honoured and not refused',
  );
  for (const bad of ['0', '-5', 'lots', '2.5', '']) {
    assert.equal(
      analysisCacheSettingsFromEnv({ ANALYSIS_CACHE_ENTRIES: bad }).hotEntries,
      500,
      `"${bad}" must resolve to the default`,
    );
  }
});

test('the hot deadline is far below any retention window it could sit under', () => {
  const shortest = analysisCacheSettingsFromEnv({ ANALYSIS_CACHE_TTL_DAYS: '1' }).ttlMs;
  assert.ok(
    HOT_CACHE_TTL_MS * 100 < shortest,
    'the hot tier must be a rounding error against retention, or it becomes a second policy',
  );
});

test('hot outcomes reach metrics as a bounded, non-identifying label set', () => {
  const metrics = new InMemoryMetrics();
  const telemetry = new AnalysisCacheObservability({
    metrics,
    logger: new JsonLogger({}, { level: 'error', sink: () => {} }),
  });

  const all: readonly HotCacheOutcome[] = ['hit', 'miss', 'durable_hit', 'expired', 'evicted'];
  for (const outcome of all) telemetry.recordHotCache(outcome);
  telemetry.recordHotCache('hit');

  const rendered = metrics.render();
  for (const outcome of all) {
    assert.match(rendered, new RegExp(`analysis_cache_hot_total\\{outcome="${outcome}"\\}`));
  }
  assert.match(rendered, /analysis_cache_hot_total\{outcome="hit"\} 2$/m, 'the memoized counter accumulates');
  assert.doesNotMatch(rendered, /rnbqkbnr|fingerprint|stockfish/, 'no identity may reach a label');
});

// ---------------------------------------------------------------------------
// Over a real engine: what the tier must not change
// ---------------------------------------------------------------------------

const STOCKFISH_OPTIONS = [
  'option name Threads type spin default 1 min 1 max 512',
  'option name Hash type spin default 16 min 1 max 1024',
  'option name MultiPV type spin default 1 min 1 max 256',
];
const INFO = 'info depth 10 seldepth 12 nodes 12345 nps 50000 time 200 score cp 20 multipv 1 pv e2e4';

interface Rig {
  readonly manager: EngineManager;
  readonly hot: HotAnalysisCache;
  readonly delegate: CountingDelegate;
  searches(): number;
  shutdown(): Promise<void>;
}

/** An engine wired exactly as `createAnalysisEngine` wires one, over the tier under test. */
function rig(options: { fail?: boolean; delegate?: CountingDelegate } = {}): Rig {
  const delegate = options.delegate ?? new CountingDelegate();
  const hot = new HotAnalysisCache({ delegate, maxEntries: 50 });
  let searches = 0;
  const manager = new EngineManager({
    transportFactory: () =>
      new FakeEngineTransport({
        name: 'Stockfish 16',
        optionLines: STOCKFISH_OPTIONS,
        go: () => {
          searches += 1;
          if (options.fail) throw new Error('engine exploded mid-search');
          return { info: [INFO], bestmove: 'e2e4' };
        },
      }),
    cache: hot,
    minWorkers: 0,
    maxWorkers: 1,
  });
  manager.register(stockfishPlugin);
  return {
    manager,
    hot,
    delegate,
    searches: () => searches,
    shutdown: () => manager.shutdown({ deadlineMs: 2_000 }),
  };
}

function analyze(node: Rig, signal?: AbortSignal): Promise<readonly EngineResult[]> {
  return node.manager.analyze({
    fen: FEN,
    variant: 'standard',
    limits: { depth: 10 },
    ...(signal !== undefined ? { signal } : {}),
  });
}

test('a validated engine result populates the hot tier and is served from it', async () => {
  const node = rig();
  try {
    const first = await analyze(node);
    assert.equal(node.searches(), 1);
    assert.equal(node.delegate.writes, 1, 'the durable write still happens, unchanged');

    const second = await analyze(node);
    assert.deepEqual(second, first, 'the cached analysis is the analysis, not an approximation');
    assert.equal(node.searches(), 1, 'the second request runs no search');
    assert.equal(node.delegate.reads, 1, 'and reaches PostgreSQL only on the first, cold lookup');
  } finally {
    await node.shutdown();
  }
});

test('a failed engine computation is never cached', async () => {
  const node = rig({ fail: true });
  try {
    await assert.rejects(analyze(node));

    assert.equal(node.hot.size, 0, 'a failure must leave no entry behind');
    assert.equal(node.delegate.writes, 0, 'and must not reach the durable tier either');
  } finally {
    await node.shutdown();
  }
});

test('a value the orchestrator rejects is never served, and the engine answers instead', async () => {
  // An empty result set passes every per-field check and is still unusable — the case
  // `decodeAnalysisPayload` calls out. The orchestrator refuses it, so a delegate that somehow
  // produced one costs a recomputation rather than a wrong answer.
  const delegate = new CountingDelegate([]);
  const node = rig({ delegate });
  try {
    const found = await analyze(node);

    assert.equal(node.searches(), 1, 'the rejected value must not stand in for an analysis');
    assert.equal(found[0]?.depth, 10, 'the caller gets the engine result');
  } finally {
    await node.shutdown();
  }
});

test('single-flight is unchanged: a storm of identical requests runs one search', async () => {
  const node = rig();
  try {
    const all = await Promise.all(Array.from({ length: 8 }, () => analyze(node)));

    assert.equal(node.searches(), 1, 'eight callers, one search');
    for (const result of all) assert.equal(result[0]?.depth, 10);
  } finally {
    await node.shutdown();
  }
});

test('cancellation is unchanged: an aborted caller is rejected and poisons nothing', async () => {
  const node = rig();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(analyze(node, controller.signal));

    // The cancelled request must leave the tier exactly as it found it, so the next caller gets a
    // real analysis rather than the wreckage of an abandoned one.
    const found = await analyze(node);
    assert.equal(found[0]?.depth, 10);
    assert.equal(node.searches(), 1, 'the cancelled request started no search of its own');
  } finally {
    await node.shutdown();
  }
});

test('durable fail-open is unchanged: a dead durable tier costs a recomputation, not an error', async () => {
  const delegate = new CountingDelegate();
  delegate.failReadWith = new Error('pool has ended');
  delegate.failWriteWith = new Error('pool has ended');
  const node = rig({ delegate });
  try {
    const found = await analyze(node);

    assert.equal(found[0]?.depth, 10, 'the caller still gets a real analysis');
    assert.equal(node.searches(), 1);
    // And the hot tier keeps working underneath the outage, which is the point of writing it first.
    const second = await analyze(node);
    assert.equal(node.searches(), 1, 'memory still answers while the database is gone');
    assert.equal(second[0]?.depth, 10);
  } finally {
    await node.shutdown();
  }
});
