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

test('gameToDocument: creates SearchableDocument with namespaced id, white/black/winner, and canonicalized fields', () => {
  const input: GameDocumentInput = {
    id: '018f2f45-9876-7890-abcd-ef0123456789',
    whiteHandle: 'MagnusCarlsen',
    blackHandle: 'HikaruNakamura',
    variant: 'Standard',
    speed: 'Blitz',
    result: '1-0',
    rated: true,
    eco: 'C50',
  };

  const doc = gameToDocument(input);

  assert.strictEqual(doc.id, 'game:018f2f45-9876-7890-abcd-ef0123456789');
  assert.strictEqual(doc.text, 'MagnusCarlsen HikaruNakamura C50 Standard Blitz');
  assert.deepEqual(doc.fields, {
    type: 'game',
    variant: 'standard',
    speed: 'blitz',
    result: '1-0',
    rated: 'true',
    white: 'magnuscarlsen',
    black: 'hikarunakamura',
    winner: 'magnuscarlsen',
    eco: 'c50',
  });
});

test('gameToDocument: handles draw game and unrated game without ECO code', () => {
  const input: GameDocumentInput = {
    id: 'g-123',
    whiteHandle: 'Alice',
    blackHandle: 'Bob',
    variant: 'standard',
    speed: 'rapid',
    result: '1/2-1/2',
    rated: false,
  };

  const doc = gameToDocument(input);

  assert.strictEqual(doc.id, 'game:g-123');
  assert.strictEqual(doc.text, 'Alice Bob standard rapid');
  assert.deepEqual(doc.fields, {
    type: 'game',
    variant: 'standard',
    speed: 'rapid',
    result: '1/2-1/2',
    rated: 'false',
    white: 'alice',
    black: 'bob',
    winner: 'draw',
  });
});

test('playerToDocument: creates SearchableDocument with namespaced id and country field', () => {
  const input: PlayerDocumentInput = {
    id: '018f2f45-1111-2222-3333-444455556666',
    handle: 'GrandmasterFlash',
    country: 'NO',
  };

  const doc = playerToDocument(input);

  assert.strictEqual(doc.id, 'player:018f2f45-1111-2222-3333-444455556666');
  assert.strictEqual(doc.text, 'GrandmasterFlash');
  assert.deepEqual(doc.fields, {
    type: 'player',
    country: 'no',
  });
});

test('tournamentToDocument: creates SearchableDocument with namespaced id and format/state fields', () => {
  const input: TournamentDocumentInput = {
    id: 't-super-blitz-2026',
    name: 'Super Blitz Arena 2026',
    format: 'Arena',
    state: 'Running',
  };

  const doc = tournamentToDocument(input);

  assert.strictEqual(doc.id, 'tournament:t-super-blitz-2026');
  assert.strictEqual(doc.text, 'Super Blitz Arena 2026');
  assert.deepEqual(doc.fields, {
    type: 'tournament',
    format: 'arena',
    state: 'running',
  });
});

test('SECURITY / PII REGRESSION TEST: player document contains NO email, email_hash, or flags substring', () => {
  const userRowWithPii = {
    id: '018f2f45-9999-8888-7777-666655554444',
    handle: 'secret_user',
    email: 'user_private_email@example.com',
    emailHash: Buffer.from('secret_hash'),
    country: 'US',
    flags: { is_admin: true, internal_notes: 'confidential' },
  };

  const input: PlayerDocumentInput = {
    id: userRowWithPii.id,
    handle: userRowWithPii.handle,
    country: userRowWithPii.country,
  };

  const doc = playerToDocument(input);

  assert.strictEqual(doc.text, 'secret_user');
  assert.strictEqual(doc.text.includes('user_private_email@example.com'), false);
  assert.strictEqual(doc.text.includes('example.com'), false);
  assert.strictEqual(doc.text.includes('secret_hash'), false);
  assert.strictEqual(doc.text.includes('confidential'), false);

  assert.deepEqual(doc.fields, {
    type: 'player',
    country: 'us',
  });

  const docString = JSON.stringify(doc);
  assert.strictEqual(docString.includes('user_private_email'), false);
  assert.strictEqual(docString.includes('example.com'), false);
  assert.strictEqual(docString.includes('secret_hash'), false);
  assert.strictEqual(docString.includes('confidential'), false);
});

test('display: gives a game a readable title and a subtitle from data already indexed', () => {
  const doc = gameToDocument({
    id: 'g1',
    whiteHandle: 'Kasparov',
    blackHandle: 'DeepBlue',
    variant: 'Standard',
    speed: 'Blitz',
    result: '1-0',
    rated: true,
  });

  // Original casing, unlike `fields`, which canonicalizes to lowercase for exact-match filtering.
  assert.equal(doc.display?.type, 'game');
  assert.equal(doc.display?.title, 'Kasparov vs DeepBlue');
  assert.equal(doc.display?.subtitle, 'Standard · Blitz · 1-0');
  assert.equal(doc.fields?.white, 'kasparov', 'fields stay canonicalized');
});

test('display: degrades a game title to the side that is present rather than rendering an empty vs', () => {
  const doc = gameToDocument({
    id: 'g2',
    whiteHandle: 'Solo',
    blackHandle: '   ',
    variant: 'Standard',
    speed: 'Bullet',
    result: '*',
    rated: false,
  });
  assert.equal(doc.display?.title, 'Solo');
});

test('display: titles a player by handle and never carries anything else about them', () => {
  const doc = playerToDocument({ id: 'p1', handle: 'MagnusC', country: 'NO' });

  // The SECURITY note on playerToDocument says email, email_hash and flags are never indexed, and
  // `display` must reuse only the handle and country the projection already had. Asserted as the
  // whole document rather than a scan for forbidden substrings: a handle may legitimately contain
  // "hash" or "flag", and a substring denylist would fail on those while still missing any leak
  // that arrives under a name nobody thought to list. Anything new on a player document has to be
  // added here deliberately, which is the point.
  assert.deepEqual(doc, {
    id: 'player:p1',
    text: 'MagnusC',
    fields: { type: 'player', country: 'no' },
    display: { type: 'player', title: 'MagnusC', subtitle: 'NO' },
  });
});

test('display: titles a tournament by name with format and state beneath', () => {
  const doc = tournamentToDocument({
    id: 't1',
    name: 'Summer Arena',
    format: 'Arena',
    state: 'Running',
  });
  assert.equal(doc.display?.type, 'tournament');
  assert.equal(doc.display?.title, 'Summer Arena');
  assert.equal(doc.display?.subtitle, 'Arena · Running');
});
