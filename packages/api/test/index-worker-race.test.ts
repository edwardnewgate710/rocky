import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySearchRepository, type GameDocumentInput } from '@chess-platform/search';
import { SearchIndexWorker, type SearchIndexSubscriber, type SearchGameSource } from '../src';

class FakeSubscriber implements SearchIndexSubscriber {
  public handler: ((msg: unknown) => void) | undefined;
  subscribe(_c: string, h: (msg: unknown) => void): () => void {
    this.handler = h;
    return () => { this.handler = undefined; };
  }
  emit(msg: unknown): void { this.handler?.(msg); }
}

class FakeGameSource implements SearchGameSource {
  public games = new Map<string, GameDocumentInput>();
  public calls = 0;
  async findGame(id: string): Promise<GameDocumentInput | null> {
    this.calls += 1;
    return this.games.get(id) ?? null;
  }
}

const base = { whiteHandle: 'alice', blackHandle: 'bob', variant: 'standard', speed: 'blitz', rated: true };

test('RACE: projection lags the ended broadcast -> game must still get indexed on redelivery', async () => {
  const sub = new FakeSubscriber();
  const src = new FakeGameSource();
  const repo = new InMemorySearchRepository();
  const worker = new SearchIndexWorker(sub, 'games:ended', src, repo);

  // The authority published `ended`, but the `games` projection row has not been
  // updated with the result yet, so findGame sees COALESCE(result, '*') === '*'.
  src.games.set('g-race', { id: 'g-race', result: '*', ...base });

  worker.start();
  sub.emit({ t: 'ended', gameId: 'g-race' });
  await worker.drain();
  assert.strictEqual(await repo.size(), 0, 'not indexable yet — correct to skip for now');

  // Projection catches up: the real result lands.
  src.games.set('g-race', { id: 'g-race', result: '1-0', ...base });

  // Redelivery (Redis is at-least-once; another replica or a retry re-emits).
  sub.emit({ t: 'ended', gameId: 'g-race' });
  await worker.drain();

  assert.strictEqual(await repo.size(), 1, 'game MUST be indexed once its result is visible');
  worker.stop();
});

test('CONTROL: a genuinely missing game must not be permanently poisoned either', async () => {
  const sub = new FakeSubscriber();
  const src = new FakeGameSource();
  const repo = new InMemorySearchRepository();
  const worker = new SearchIndexWorker(sub, 'games:ended', src, repo);

  worker.start();
  sub.emit({ t: 'ended', gameId: 'g-late' });   // not in projection at all yet
  await worker.drain();
  assert.strictEqual(await repo.size(), 0);

  src.games.set('g-late', { id: 'g-late', result: '0-1', ...base });
  sub.emit({ t: 'ended', gameId: 'g-late' });
  await worker.drain();

  assert.strictEqual(await repo.size(), 1, 'a late-arriving row MUST be indexable on redelivery');
  worker.stop();
});
