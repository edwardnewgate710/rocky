import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { SearchableDocument } from '@chess-platform/search';
import { parseSearchQuery } from '@chess-platform/search';
import { createPool } from '../src/pg/pool';
import { migrate } from '../src/pg/migrate';
import { PgSearchRepository } from '../src/pg/search';
import { uuidv7 } from '../src/ids';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

test('pg search repository: migrate, index, query, upsert, remove, and pagination', { skip }, async () => {
  const pool = createPool();
  // Hermetic without a destructive table-wide clear(): every doc carries a unique
  // `ns` field, every query is scoped by `ns:<ns>`, size is checked relative to the
  // starting count, and cleanup deletes only this run's rows (mirrors the scoped
  // cleanup in tournaments.pg.integration.test.ts). Safe against a shared DB.
  const ns = uuidv7();
  const q = (s: string) => parseSearchQuery(`${s} ns:${ns}`);
  try {
    await migrate(pool, join(process.cwd(), 'migrations'));
    const repo = new PgSearchRepository(pool);
    const sizeBefore = await repo.size();

    const doc1: SearchableDocument = {
      id: `${ns}-1`,
      text: 'Sicilian Defense Najdorf Variation',
      fields: { ns, variant: 'blitz', result: '1-0' },
    };
    const doc2: SearchableDocument = {
      id: `${ns}-2`,
      text: 'French Defense Winawer Variation',
      fields: { ns, variant: 'blitz', result: '0-1' },
    };
    const doc3: SearchableDocument = {
      id: `${ns}-3`,
      text: 'Caro-Kann Defense Classical Variation',
      fields: { ns, variant: 'rapid' },
    };

    await repo.index(doc1);
    await repo.indexAll([doc2, doc3]);
    assert.equal(await repo.size(), sizeBefore + 3);

    // 1. Term match (scoped)
    const termRes = await repo.query(q('Sicilian'));
    assert.equal(termRes.total, 1);
    assert.equal(termRes.results.length, 1);
    assert.equal(termRes.results[0]?.id, `${ns}-1`);
    assert.ok((termRes.results[0]?.score ?? 0) > 0);

    // 2. Case-insensitive field:value filter (values stored lowercased)
    const filterRes = await repo.query(q('variant:BLITZ'));
    assert.equal(filterRes.total, 2);
    assert.deepEqual(filterRes.results.map((r) => r.id).sort(), [`${ns}-1`, `${ns}-2`]);

    // 3. Negated filter, incl. a doc that is missing the field (absent => a hit)
    const negatedRes = await repo.query(q('-variant:blitz'));
    assert.equal(negatedRes.total, 1);
    assert.equal(negatedRes.results[0]?.id, `${ns}-3`);
    const negatedResultRes = await repo.query(q('-result:1-0'));
    assert.equal(negatedResultRes.total, 2); // doc2 (0-1) + doc3 (missing result)
    assert.deepEqual(negatedResultRes.results.map((r) => r.id).sort(), [`${ns}-2`, `${ns}-3`]);

    // 4. Filters-only => score 0, ordered by id ASC
    const filtersOnlyRes = await repo.query(q('variant:blitz'));
    assert.equal(filtersOnlyRes.total, 2);
    assert.equal(filtersOnlyRes.results[0]?.id, `${ns}-1`);
    assert.equal(filtersOnlyRes.results[0]?.score, 0);
    assert.equal(filtersOnlyRes.results[1]?.id, `${ns}-2`);

    // 5. Upsert by id: same id, new text/fields
    await repo.index({
      id: `${ns}-1`,
      text: 'King Indian Defense Classical Variation',
      fields: { ns, variant: 'classical', result: '1-0' },
    });
    assert.equal(await repo.size(), sizeBefore + 3);
    assert.equal((await repo.query(q('Sicilian'))).total, 0);
    const newTermRes = await repo.query(q('King'));
    assert.equal(newTermRes.total, 1);
    assert.equal(newTermRes.results[0]?.id, `${ns}-1`);

    // 6. Remove: true then false; size decrements
    assert.equal(await repo.remove(`${ns}-1`), true);
    assert.equal(await repo.remove(`${ns}-1`), false);
    assert.equal(await repo.size(), sizeBefore + 2);

    // 7. Pagination — three deterministically ordered filters-only docs
    await repo.indexAll([
      { id: `${ns}-p1`, text: 'Defense game one', fields: { ns, category: 'test' } },
      { id: `${ns}-p2`, text: 'Defense game two', fields: { ns, category: 'test' } },
      { id: `${ns}-p3`, text: 'Defense game three', fields: { ns, category: 'test' } },
    ]);

    // In-range nonzero offset over the id-ordered filters-only set: skip p1, take p2.
    const catPage = await repo.query(q('category:test'), { limit: 1, offset: 1 });
    assert.equal(catPage.total, 3); // p1, p2, p3
    assert.equal(catPage.results.length, 1);
    assert.equal(catPage.results[0]?.id, `${ns}-p2`);

    // 'Defense' now matches doc2, doc3, p1, p2, p3 (doc1 removed) = 5.
    const page1 = await repo.query(q('Defense'), { limit: 2, offset: 0 });
    assert.equal(page1.total, 5);
    assert.equal(page1.results.length, 2);

    const pastEnd = await repo.query(q('Defense'), { offset: 10 });
    assert.equal(pastEnd.total, 5);
    assert.equal(pastEnd.results.length, 0);
  } finally {
    // Scoped cleanup — only this run's rows; never a table-wide DELETE.
    await pool.query("DELETE FROM search_documents WHERE fields->>'ns' = $1", [ns]);
    await pool.end();
  }
});
