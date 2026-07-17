import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decode } from '../src/protocol';

test('decode validates every client-message field before returning a typed value', () => {
  assert.deepEqual(decode('{"t":"join","gameId":"g1","token":"abc"}'), {
    t: 'join', gameId: 'g1', token: 'abc',
  });
  assert.deepEqual(decode('{"t":"move","gameId":"g1","uci":"e2e4","clientSeq":1}'), {
    t: 'move', gameId: 'g1', uci: 'e2e4', clientSeq: 1,
  });
  assert.deepEqual(decode('{"t":"resume","gameId":"g1","lastPly":0}'), {
    t: 'resume', gameId: 'g1', lastPly: 0,
  });
  assert.deepEqual(decode('{"t":"ping","ts":42}'), { t: 'ping', ts: 42 });
});

test('decode rejects malformed field types for every client-message family', () => {
  const malformed = [
    '{',
    '[]',
    '{"t":"join","gameId":"g1","token":{}}',
    '{"t":"join","gameId":12}',
    '{"t":"move","gameId":"g1","uci":{},"clientSeq":1}',
    '{"t":"move","gameId":"g1","uci":"e2e4","clientSeq":0}',
    '{"t":"move","gameId":"g1","uci":"e2e4","clientSeq":1.5}',
    '{"t":"resign","gameId":null}',
    '{"t":"resume","gameId":"g1","lastPly":-1}',
    '{"t":"resume","gameId":"g1","lastPly":"0"}',
    '{"t":"ping","ts":"42"}',
    '{"t":"ping","ts":null}',
    '{"t":"unknown"}',
  ];

  for (const frame of malformed) {
    assert.equal(decode(frame), null, frame);
  }
});
