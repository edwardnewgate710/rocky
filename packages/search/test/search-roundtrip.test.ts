import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
  gameToDocument,
  playerToDocument,
  tournamentToDocument,
  type GameDocumentInput,
  type PlayerDocumentInput,
  type TournamentDocumentInput,
} from '../src/projections';
import { parseNaturalQuery } from '../src/natural';
import { InMemorySearchRepository } from '../src/repository';

test('search-roundtrip: natural query "blitz games" matches projected blitz game document', async () => {
  const repo = new InMemorySearchRepository();

  const gameInput: GameDocumentInput = {
    id: '018f2f45-0000-7000-8000-000000000001',
    whiteHandle: 'magnus',
    blackHandle: 'hikaru',
    variant: 'standard',
    speed: 'blitz',
    result: '1-0',
    rated: true,
    eco: 'C50',
  };

  const doc = gameToDocument(gameInput);
  await repo.index(doc);

  const query = parseNaturalQuery('blitz games');
  const page = await repo.query(query);

  assert.strictEqual(page.total, 1, 'Expected 1 matching game for query "blitz games"');
  assert.strictEqual(page.results[0]?.id, 'game:018f2f45-0000-7000-8000-000000000001');
});

test('search-roundtrip: natural query "standard matches" matches standard variant game document', async () => {
  const repo = new InMemorySearchRepository();

  const gameInput: GameDocumentInput = {
    id: '018f2f45-0000-7000-8000-000000000002',
    whiteHandle: 'alice',
    blackHandle: 'bob',
    variant: 'standard',
    speed: 'rapid',
    result: '0-1',
    rated: false,
  };

  await repo.index(gameToDocument(gameInput));

  const query = parseNaturalQuery('standard matches');
  const page = await repo.query(query);

  assert.strictEqual(page.total, 1);
  assert.strictEqual(page.results[0]?.id, 'game:018f2f45-0000-7000-8000-000000000002');
});

test('search-roundtrip: natural query "draws" matches drawn game document', async () => {
  const repo = new InMemorySearchRepository();

  const gameInput: GameDocumentInput = {
    id: '018f2f45-0000-7000-8000-000000000003',
    whiteHandle: 'caruana',
    blackHandle: 'nepo',
    variant: 'standard',
    speed: 'classical',
    result: '1/2-1/2',
    rated: true,
  };

  await repo.index(gameToDocument(gameInput));

  const query = parseNaturalQuery('draws');
  const page = await repo.query(query);

  assert.strictEqual(page.total, 1);
  assert.strictEqual(page.results[0]?.id, 'game:018f2f45-0000-7000-8000-000000000003');
});

test('search-roundtrip: natural queries for players and tournaments', async () => {
  const repo = new InMemorySearchRepository();

  const playerInput: PlayerDocumentInput = {
    id: 'p-1',
    handle: 'Kasparov',
    country: 'RU',
  };

  const tournamentInput: TournamentDocumentInput = {
    id: 't-1',
    name: 'Linares 1994',
    format: 'round_robin',
    state: 'finished',
  };

  await repo.indexAll([playerToDocument(playerInput), tournamentToDocument(tournamentInput)]);

  const playerPage = await repo.query(parseNaturalQuery('players'));
  assert.strictEqual(playerPage.total, 1);
  assert.strictEqual(playerPage.results[0]?.id, 'player:p-1');

  const tournPage = await repo.query(parseNaturalQuery('tournaments'));
  assert.strictEqual(tournPage.total, 1);
  assert.strictEqual(tournPage.results[0]?.id, 'tournament:t-1');
});

test('search-roundtrip: explicit white/black/winner filters against game projection', async () => {
  const repo = new InMemorySearchRepository();

  const game1: GameDocumentInput = {
    id: 'g-white-win',
    whiteHandle: 'Magnus',
    blackHandle: 'Hikaru',
    variant: 'standard',
    speed: 'blitz',
    result: '1-0',
    rated: true,
  };

  const game2: GameDocumentInput = {
    id: 'g-black-win',
    whiteHandle: 'Hikaru',
    blackHandle: 'Magnus',
    variant: 'standard',
    speed: 'blitz',
    result: '0-1',
    rated: true,
  };

  await repo.indexAll([gameToDocument(game1), gameToDocument(game2)]);

  const whiteMagnusPage = await repo.query(parseNaturalQuery('white:magnus'));
  assert.strictEqual(whiteMagnusPage.total, 1);
  assert.strictEqual(whiteMagnusPage.results[0]?.id, 'game:g-white-win');

  const winnerMagnusPage = await repo.query(parseNaturalQuery('winner:magnus'));
  assert.strictEqual(winnerMagnusPage.total, 2);
});

// Every speed word in NATURAL_VOCABULARY must match a document the projection actually
// emits. A vocabulary entry that points at the wrong field (the ADR-0051 bug this
// increment fixed) is invisible to a parser-only test but fails here.
test('search-roundtrip: every speed vocabulary term matches its projected document', async () => {
  const speeds: readonly string[] = [
    'ultrabullet',
    'bullet',
    'blitz',
    'rapid',
    'classical',
    'correspondence',
  ];

  for (const speed of speeds) {
    const repo = new InMemorySearchRepository();
    await repo.index(
      gameToDocument({
        id: `g-speed-${speed}`,
        whiteHandle: 'alice',
        blackHandle: 'bob',
        variant: 'standard',
        speed,
        result: '1-0',
        rated: true,
      })
    );

    const page = await repo.query(parseNaturalQuery(speed));
    assert.strictEqual(page.total, 1, `speed term "${speed}" should match its projected document`);
    assert.strictEqual(page.results[0]?.id, `game:g-speed-${speed}`);
  }
});

// Same guarantee for variants, including the aliases (960, koth). Fixtures are stored
// upper-cased so the projection's lowercase canonicalization is exercised too.
test('search-roundtrip: every variant vocabulary term matches its canonical projected code', async () => {
  const variants: ReadonlyArray<readonly [string, string]> = [
    ['standard', 'standard'],
    ['chess960', 'chess960'],
    ['960', 'chess960'],
    ['kingofthehill', 'kingofthehill'],
    ['koth', 'kingofthehill'],
    ['atomic', 'atomic'],
    ['crazyhouse', 'crazyhouse'],
    ['threecheck', 'threecheck'],
    ['horde', 'horde'],
    ['racingkings', 'racingkings'],
  ];

  for (const [term, code] of variants) {
    const repo = new InMemorySearchRepository();
    await repo.index(
      gameToDocument({
        id: `g-variant-${code}`,
        whiteHandle: 'alice',
        blackHandle: 'bob',
        variant: code.toUpperCase(),
        speed: 'blitz',
        result: '1-0',
        rated: true,
      })
    );

    const page = await repo.query(parseNaturalQuery(term));
    assert.strictEqual(page.total, 1, `variant term "${term}" should match canonical code "${code}"`);
    assert.strictEqual(page.results[0]?.id, `game:g-variant-${code}`);
  }
});
