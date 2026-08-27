/**
 * Hermetic coverage for the durable analysis cache: the payload contract, and how the adapter
 * behaves when the database or the data lets it down. The SQL predicates themselves need a real
 * server and are covered in `analysis-cache.integration.test.ts`.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import type { Pool } from 'pg';
import type { AnalysisLimits, EngineResult } from '@chess-platform/engine';
import {
  ANALYSIS_CACHE_PAYLOAD_VERSION,
  AnalysisCachePayloadError,
  decodeAnalysisPayload,
  encodeAnalysisPayload,
  toStoredLimits,
} from '../src/analysis-cache';
import { PgAnalysisCache, type AnalysisCacheFault } from '../src/pg/analysis-cache';

const KEY = { fingerprint: 'fp', fen: 'FEN', variant: 'standard', multiPv: 1 };

/** Every contractually meaningful field set, including both optionals. */
const RICH: EngineResult = {
  multipv: 2,
  evaluation: { type: 'mate', value: -3 },
  evaluationBound: 'upperbound',
  principalVariation: ['e2e4', 'e7e5', 'g1f3'],
  depth: 22,
  selDepth: 31,
  nodes: 9_007_199_254_740_990,
  nps: 1_250_000,
  timeMs: 7200,
};

/** Neither optional present, so absence can be told apart from presence. */
const LEAN: EngineResult = {
  multipv: 1,
  evaluation: { type: 'cp', value: 0 },
  principalVariation: [],
  depth: 0,
  nodes: 0,
  nps: 0,
  timeMs: 0,
};

function encodeOne(result: EngineResult): Record<string, unknown> {
  return encodeAnalysisPayload([result])[0] as Record<string, unknown>;
}

function roundTrip(results: readonly EngineResult[]): readonly EngineResult[] {
  // Through JSON, because that is what the column does to it.
  const stored: unknown = JSON.parse(JSON.stringify(encodeAnalysisPayload(results)));
  return decodeAnalysisPayload(ANALYSIS_CACHE_PAYLOAD_VERSION, stored);
}

/** A Pool stand-in: the driver is the system boundary, and these tests are about faults at it. */
function poolReturning(rows: unknown[]): Pool {
  return { query: async () => ({ rows }) } as unknown as Pool;
}

function poolThatFails(error: unknown): Pool {
  return {
    query: async () => {
      throw error;
    },
  } as unknown as Pool;
}

describe('analysis cache payload contract', () => {
  it('round-trips every contractually meaningful field', () => {
    assert.deepEqual(roundTrip([RICH, LEAN]), [RICH, LEAN]);
  });

  it('keeps an absent optional absent rather than turning it into null', () => {
    const [decoded] = roundTrip([LEAN]);
    assert.ok(decoded);
    assert.equal('evaluationBound' in decoded, false);
    assert.equal('selDepth' in decoded, false);
  });

  it('drops a field the contract does not name instead of storing it', () => {
    const smuggled = { ...LEAN, apiKey: 'secret', internalHandle: 42 } as unknown as EngineResult;
    const encoded = encodeOne(smuggled);
    assert.equal('apiKey' in encoded, false);
    assert.equal('internalHandle' in encoded, false);
  });

  it('refuses a payload version it cannot read rather than casting it', () => {
    const payload = encodeAnalysisPayload([LEAN]);
    assert.throws(
      () => decodeAnalysisPayload(ANALYSIS_CACHE_PAYLOAD_VERSION + 1, payload),
      AnalysisCachePayloadError,
    );
    assert.throws(() => decodeAnalysisPayload(0, payload), AnalysisCachePayloadError);
  });

  const malformed: readonly (readonly [string, unknown])[] = [
    ['a payload that is not an array', { multipv: 1 }],
    ['an entry that is not an object', ['e2e4']],
    ['a null result', [null]],
    ['a missing evaluation', [{ ...encodeOne(LEAN), evaluation: undefined }]],
    ['an unknown evaluation type', [{ ...encodeOne(LEAN), evaluation: { type: 'eval', value: 1 } }]],
    ['a non-numeric evaluation', [{ ...encodeOne(LEAN), evaluation: { type: 'cp', value: '20' } }]],
    ['a fractional evaluation', [{ ...encodeOne(LEAN), evaluation: { type: 'cp', value: 1.5 } }]],
    ['an unknown evaluation bound', [{ ...encodeOne(LEAN), evaluationBound: 'exact' }]],
    [
      'a principal variation that is not an array',
      [{ ...encodeOne(LEAN), principalVariation: 'e2e4' }],
    ],
    ['a non-string move', [{ ...encodeOne(LEAN), principalVariation: ['e2e4', 7] }]],
    ['a multipv below one', [{ ...encodeOne(LEAN), multipv: 0 }]],
    ['a negative depth', [{ ...encodeOne(LEAN), depth: -1 }]],
    ['a fractional depth', [{ ...encodeOne(LEAN), depth: 12.5 }]],
    ['a node count beyond safe integers', [{ ...encodeOne(LEAN), nodes: 1e300 }]],
    ['a missing nps', [{ ...encodeOne(LEAN), nps: undefined }]],
  ];

  for (const [what, payload] of malformed) {
    it(`refuses ${what}`, () => {
      assert.throws(
        () => decodeAnalysisPayload(ANALYSIS_CACHE_PAYLOAD_VERSION, payload),
        AnalysisCachePayloadError,
      );
    });
  }
});

describe('achieved limit projection', () => {
  it('records a stated dimension and leaves an unstated one null', () => {
    assert.deepEqual(toStoredLimits({ depth: 20 }), { depth: 20, nodes: null, timeMs: null });
    assert.deepEqual(toStoredLimits({ depth: 20, nodes: 5, timeMs: 0 }), {
      depth: 20,
      nodes: 5,
      timeMs: 0,
    });
  });

  it('refuses limits that state nothing, which no request could ever match', () => {
    assert.throws(() => toStoredLimits({}), AnalysisCachePayloadError);
  });

  const rejected: readonly (readonly [string, number])[] = [
    ['negative', -1],
    ['fractional', 18.5],
    ['beyond safe integers', 1e300],
    ['not a number at all', Number.NaN],
  ];

  for (const [what, depth] of rejected) {
    it(`refuses a ${what} limit instead of storing an untrue claim`, () => {
      assert.throws(() => toStoredLimits({ depth }), AnalysisCachePayloadError);
    });
  }
});

describe('PgAnalysisCache failure semantics', () => {
  it('reports a read failure as a miss, so a database blip cannot fail an analysis', async () => {
    const faults: AnalysisCacheFault[] = [];
    const cache = new PgAnalysisCache(poolThatFails(new Error('connection terminated')), {
      onError: (fault) => faults.push(fault),
    });

    assert.equal(await cache.get(KEY, { depth: 20 }), undefined);
    assert.deepEqual(faults, ['read']);
  });

  it('reports a write failure without throwing, so a failed write cannot fail an analysis', async () => {
    const faults: AnalysisCacheFault[] = [];
    const cache = new PgAnalysisCache(poolThatFails(new Error('read-only transaction')), {
      onError: (fault) => faults.push(fault),
    });

    await cache.set(KEY, [LEAN], { limits: { depth: 20 } });
    assert.deepEqual(faults, ['write']);
  });

  it('reports limits it cannot store as a write fault instead of writing an untrue row', async () => {
    const faults: AnalysisCacheFault[] = [];
    let queried = false;
    const pool = {
      query: async () => {
        queried = true;
        return { rows: [] };
      },
    } as unknown as Pool;
    const cache = new PgAnalysisCache(pool, { onError: (fault) => faults.push(fault) });

    await cache.set(KEY, [LEAN], { limits: { depth: -5 } });
    assert.deepEqual(faults, ['write']);
    assert.equal(queried, false, 'a limit that cannot be stored must not reach the database');
  });

  it('treats a row it cannot decode as a miss, and says so as a payload fault', async () => {
    const faults: AnalysisCacheFault[] = [];
    const pool = poolReturning([
      { payload_version: ANALYSIS_CACHE_PAYLOAD_VERSION, results: [{ multipv: 'first' }] },
    ]);
    const cache = new PgAnalysisCache(pool, { onError: (fault) => faults.push(fault) });

    assert.equal(await cache.get(KEY, { depth: 1 }), undefined);
    assert.deepEqual(
      faults,
      ['payload'],
      'corruption is a different alert from an unreachable database',
    );
  });

  it('treats a payload version it does not speak as a miss, not as results', async () => {
    const faults: AnalysisCacheFault[] = [];
    const pool = poolReturning([
      {
        payload_version: ANALYSIS_CACHE_PAYLOAD_VERSION + 1,
        results: encodeAnalysisPayload([LEAN]),
      },
    ]);
    const cache = new PgAnalysisCache(pool, { onError: (fault) => faults.push(fault) });

    assert.equal(await cache.get(KEY, { depth: 1 }), undefined);
    assert.deepEqual(faults, ['payload']);
  });

  it('survives a reporter that throws, which would otherwise re-break what it absorbed', async () => {
    const cache = new PgAnalysisCache(poolThatFails(new Error('down')), {
      onError: () => {
        throw new Error('the logger is down too');
      },
    });

    assert.equal(await cache.get(KEY, { depth: 20 }), undefined);
    await cache.set(KEY, [LEAN], { limits: { depth: 20 } });
  });

  it('absorbs faults when no reporter was supplied at all', async () => {
    const cache = new PgAnalysisCache(poolThatFails(new Error('down')));
    assert.equal(await cache.get(KEY, { depth: 20 }), undefined);
    await cache.set(KEY, [LEAN], { limits: { depth: 20 } });
  });

  /**
   * Each dimension is asserted on its own. A single case that states `depth` would leave the
   * `nodes` and `timeMs` mappings unexercised, and a `?? 0` slipped into either of them would
   * ask the database for "a bound of at least zero" — which every row satisfies — while the
   * test went on passing.
   */
  const dimensions: readonly (readonly [string, AnalysisLimits, unknown[]])[] = [
    ['depth', { depth: 20 }, [20, null, null]],
    ['nodes', { nodes: 900_000 }, [null, 900_000, null]],
    ['timeMs', { timeMs: 3000 }, [null, null, 3000]],
  ];

  for (const [dimension, requested, expected] of dimensions) {
    it(`asks for nothing in a dimension the request omits, stating only ${dimension}`, async () => {
      let params: unknown[] = [];
      const pool = {
        query: async (_sql: string, values: unknown[]) => {
          params = values;
          return { rows: [] };
        },
      } as unknown as Pool;

      await new PgAnalysisCache(pool).get(KEY, requested);

      assert.deepEqual(
        params.slice(4),
        expected,
        'an unstated dimension must be NULL, not 0, which every stored row would satisfy',
      );
    });
  }
});
