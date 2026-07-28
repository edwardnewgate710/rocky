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
