import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { SemanticSearchableDocument } from '@chess-platform/search';
import { parseSearchQuery, HashingEmbeddingProvider } from '@chess-platform/search';
import { createPool } from '../src/pg/pool';
import { migrate } from '../src/pg/migrate';
import { PgSemanticSearchRepository } from '../src/pg/semantic-search';
import { PgSearchRepository } from '../src/pg/search';
import { uuidv7 } from '../src/ids';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

test('pg semantic search repository: migrate, index, semantic query, upsert, remove, filters, pagination, hybrid, and dimension error', { skip }, async () => {
  const pool = createPool();
  const ns = uuidv7();
  const provider = new HashingEmbeddingProvider(256);
  const q = (s: string) => parseSearchQuery(`${s} ns:${ns}`);
  const nsFilter = { field: 'ns', value: ns, negated: false };

  try {
    await migrate(pool, join(process.cwd(), 'migrations'));
    const repo = new PgSemanticSearchRepository(pool);
    const keywordRepo = new PgSearchRepository(pool);
    const sizeBefore = await repo.size();

    const text1 = 'Sicilian Defense Najdorf Variation';
    const text2 = 'French Defense Winawer Variation';
    const text3 = 'Caro-Kann Defense Classical Variation';

    const emb1 = await provider.embed(text1);
    const emb2 = await provider.embed(text2);
    const emb3 = await provider.embed(text3);

    const doc1: SemanticSearchableDocument = {
      id: `${ns}-1`,
      text: text1,
      embedding: emb1,
      fields: { ns, variant: 'blitz', result: '1-0' },
    };
    const doc2: SemanticSearchableDocument = {
      id: `${ns}-2`,
      text: text2,
      embedding: emb2,
      fields: { ns, variant: 'blitz', result: '0-1' },
    };
    const doc3: SemanticSearchableDocument = {
      id: `${ns}-3`,
      text: text3,
      embedding: emb3,
      fields: { ns, variant: 'rapid' },
    };

    await repo.index(doc1);
    await repo.indexAll([doc2, doc3]);
    assert.equal(await repo.size(), sizeBefore + 3);

    // 1. Semantic query ranking order (nearest to doc1's text vector)
    const semRes = await repo.querySemantic(emb1, { filters: [nsFilter] });
    assert.equal(semRes.total, 3);
    assert.equal(semRes.results[0]?.id, `${ns}-1`);
    assert.ok((semRes.results[0]?.score ?? 0) > 0.9999);

    // 2. Upsert by id (re-indexing changes the embedding)
    const newText1 = 'King Indian Defense Classical Variation';
    const newEmb1 = await provider.embed(newText1);
    await repo.index({
      id: `${ns}-1`,
      text: newText1,
      embedding: newEmb1,
      fields: { ns, variant: 'classical', result: '1-0' },
    });
    assert.equal(await repo.size(), sizeBefore + 3);

    const updatedRes = await repo.querySemantic(newEmb1, { filters: [nsFilter] });
    assert.equal(updatedRes.results[0]?.id, `${ns}-1`);

    // 3. Remove and return value: removes from semantic index, keyword doc survives
    assert.equal(await repo.remove(`${ns}-1`), true);
    assert.equal(await repo.remove(`${ns}-1`), false);
    assert.equal(await repo.size(), sizeBefore + 2);
    // Keyword document still exists in search_documents
    const kwRes = await keywordRepo.query(parseSearchQuery(`King ns:${ns}`));
    assert.equal(kwRes.total, 1);
    assert.equal(kwRes.results[0]?.id, `${ns}-1`);

    // Re-index doc1 so all 3 docs are present for remaining tests
    await repo.index(doc1);

    // 4. minScore thresholding
    const thresholdRes = await repo.querySemantic(emb2, { minScore: 0.95, filters: [nsFilter] });
    assert.equal(thresholdRes.total, 1);
    assert.equal(thresholdRes.results[0]?.id, `${ns}-2`);

    // Invalid minScore rejects with RangeError. querySemantic is async, so the validation throw
    // surfaces as a rejected promise — assert.throws would report "missing expected exception".
    await assert.rejects(
      () => repo.querySemantic(emb2, { minScore: NaN }),
      RangeError,
    );

    // An unfiltered query must work. It is deliberately NOT ns-scoped: the regression it guards is
    // a parameter-binding mismatch that only appears when the WHERE clause is empty, so scoping it
    // would hide the bug. It therefore asserts only shape and the presence of this run's rows,
    // never exact ids or totals, so it stays correct against a shared database.
    const unfiltered = await repo.querySemantic(emb1, { limit: 5 });
    assert.ok(unfiltered.total >= 3, `expected at least this run's 3 rows, got ${unfiltered.total}`);
    assert.ok(unfiltered.results.length <= 5);
    for (const hit of unfiltered.results) {
      assert.equal(typeof hit.id, 'string');
      assert.ok(Number.isFinite(hit.score));
    }

    // 5. jsonb filters including negation
    const filterRes = await repo.querySemantic(emb1, {
      filters: [nsFilter, { field: 'variant', value: 'BLITZ', negated: false }],
    });
    assert.equal(filterRes.total, 2);
    assert.deepEqual(
      filterRes.results.map((r) => r.id).sort(),
      [`${ns}-1`, `${ns}-2`],
    );

    const negatedRes = await repo.querySemantic(emb1, {
      filters: [nsFilter, { field: 'variant', value: 'blitz', negated: true }],
    });
    assert.equal(negatedRes.total, 1);
    assert.equal(negatedRes.results[0]?.id, `${ns}-3`);

    // 6. Pagination (in-range offset, beyond-end offset, negative clamp)
    const pageRes = await repo.querySemantic(emb1, {
      filters: [nsFilter],
      limit: 1,
      offset: 1,
    });
    assert.equal(pageRes.total, 3);
    assert.equal(pageRes.results.length, 1);

    const pastEndRes = await repo.querySemantic(emb1, {
      filters: [nsFilter],
      offset: 10,
    });
    assert.equal(pastEndRes.total, 3);
    assert.equal(pastEndRes.results.length, 0);

    const negClampRes = await repo.querySemantic(emb1, {
      filters: [nsFilter],
      limit: -5,
      offset: -10,
    });
    assert.equal(negClampRes.total, 3);
    assert.equal(negClampRes.results.length, 0);

    // 7. queryHybrid union behavior and weight extremes
    const hybridRes = await repo.queryHybrid(q('Sicilian'), emb2, { filters: [nsFilter] });
    assert.equal(hybridRes.total, 3);

    // keywordWeight: 1 (only keyword hits returned)
    const kwOnlyRes = await repo.queryHybrid(q('Sicilian'), emb2, {
      keywordWeight: 1,
      filters: [nsFilter],
    });
    assert.equal(kwOnlyRes.total, 1);
    assert.equal(kwOnlyRes.results[0]?.id, `${ns}-1`);

    // keywordWeight: 0 (only vector hits returned)
    const vecOnlyRes = await repo.queryHybrid(q('Sicilian'), emb2, {
      keywordWeight: 0,
      filters: [nsFilter],
    });
    assert.equal(vecOnlyRes.total, 3);

    // Filters parsed from the query text must constrain the vector CTE too (CodeRabbit, PR #52):
    // doc3 is variant:rapid, so querying its own embedding with `variant:blitz` in the query text
    // must not surface it through the semantic branch.
    const hybridFiltered = await repo.queryHybrid(q('Defense variant:blitz'), emb3, {
      filters: [nsFilter],
    });
    assert.ok(
      !hybridFiltered.results.some((r) => r.id === `${ns}-3`),
      'a document failing query.filters must not appear via the vector branch',
    );

    // Invalid keywordWeight or rrfK throw RangeError
    await assert.rejects(
      () => repo.queryHybrid(q('Sicilian'), emb2, { keywordWeight: 1.5 }),
      RangeError,
    );
    await assert.rejects(
      () => repo.queryHybrid(q('Sicilian'), emb2, { rrfK: -1 }),
      RangeError,
    );

    // 8. Dimension mismatch insert surfaces a clear error
    const wrongDimDoc: SemanticSearchableDocument = {
      id: `${ns}-err`,
      text: 'Wrong dimension doc',
      embedding: [0.1, 0.2, 0.3],
      fields: { ns },
    };
    await assert.rejects(
      () => repo.index(wrongDimDoc),
      (err: Error) => {
        return err.message.includes('256') || err.message.includes('dimension') || err.message.includes('vector');
      },
    );
  } finally {
    // Cleanup must never mask the real failure, nor leak the pool. If migrate() failed above,
    // search_documents may not exist and this DELETE throws — pool.end() still has to run.
    try {
      await pool.query("DELETE FROM search_documents WHERE fields->>'ns' = $1", [ns]);
    } finally {
      await pool.end();
    }
  }
});
