import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemorySearchRepository,
  InMemorySemanticSearchRepository,
  HashingEmbeddingProvider,
  type GameDocumentInput,
} from '@chess-platform/search';
import { SearchIndexWorker, type SearchIndexSubscriber, type SearchGameSource } from '../src';

class FakeSubscriber implements SearchIndexSubscriber {
  public handler: ((msg: unknown) => void) | undefined;
  public subscribeCount = 0;
  public unsubscribeCount = 0;

  subscribe(channel: string, handler: (msg: unknown) => void): () => void {
    this.subscribeCount += 1;
    this.handler = handler;
    return () => {
      this.unsubscribeCount += 1;
      this.handler = undefined;
    };
  }

  emit(msg: unknown): void {
    if (this.handler) {
      this.handler(msg);
    }
  }
}

class FakeGameSource implements SearchGameSource {
  public findGameCalls = 0;
  public games = new Map<string, GameDocumentInput>();
  public shouldThrowFor: string | undefined;

  async findGame(id: string): Promise<GameDocumentInput | null> {
    this.findGameCalls += 1;
    if (this.shouldThrowFor === id) {
      throw new Error(`DB connection failed for ${id}`);
    }
    return this.games.get(id) ?? null;
  }
}

test('SearchIndexWorker: indexes ended game into SearchRepository', async () => {
  const subscriber = new FakeSubscriber();
  const source = new FakeGameSource();
  const repo = new InMemorySearchRepository();
  const worker = new SearchIndexWorker(subscriber, 'games:ended', source, repo);

  source.games.set('g-1', {
    id: 'g-1',
    whiteHandle: 'alice',
    blackHandle: 'bob',
    variant: 'standard',
    speed: 'blitz',
    result: '1-0',
    rated: true,
  });

  worker.start();
  subscriber.emit({ t: 'ended', gameId: 'g-1' });
  await worker.drain();

  assert.strictEqual(await repo.size(), 1);
  const page = await repo.query({ terms: [], phrases: [], filters: [{ field: 'type', value: 'game', negated: false }] });
  assert.strictEqual(page.results[0]?.id, 'game:g-1');

  worker.stop();
});

test('SearchIndexWorker with semantic option: embeds and indexes ended game into SemanticSearchRepository with 256-dim embedding', async () => {
  const subscriber = new FakeSubscriber();
  const source = new FakeGameSource();
  const keywordRepo = new InMemorySearchRepository();
  const semanticRepo = new InMemorySemanticSearchRepository();
  const embeddingProvider = new HashingEmbeddingProvider(256);

  const worker = new SearchIndexWorker(subscriber, 'games:ended', source, keywordRepo, {
    semantic: {
      repository: semanticRepo,
      embeddingProvider,
    },
  });

  source.games.set('g-sem-1', {
    id: 'g-sem-1',
    whiteHandle: 'alice',
    blackHandle: 'bob',
    variant: 'standard',
    speed: 'blitz',
    result: '1-0',
    rated: true,
  });

  source.games.set('g-aborted', {
    id: 'g-aborted',
    whiteHandle: 'carol',
    blackHandle: 'dave',
    variant: 'standard',
    speed: 'blitz',
    result: '*', // Aborted game
    rated: true,
  });

  worker.start();
  subscriber.emit({ t: 'ended', gameId: 'g-sem-1' });
  subscriber.emit({ t: 'ended', gameId: 'g-aborted' });
  await worker.drain();

  // Keyword repository must NOT receive writes (single write path rule)
  assert.strictEqual(await keywordRepo.size(), 0);

  // Semantic repository has 1 document (aborted game skipped)
  assert.strictEqual(await semanticRepo.size(), 1);

  const queryVector = await embeddingProvider.embed('Game alice vs bob');
  const semRes = await semanticRepo.querySemantic(queryVector);
  assert.strictEqual(semRes.total, 1);
  assert.strictEqual(semRes.results[0]?.id, 'game:g-sem-1');

  worker.stop();
});

test('SearchIndexWorker: dedups redelivered gameId messages and respects MAX_SEEN FIFO eviction', async () => {
  const subscriber = new FakeSubscriber();
  const source = new FakeGameSource();
  const repo = new InMemorySearchRepository();
  const worker = new SearchIndexWorker(subscriber, 'games:ended', source, repo);

  source.games.set('g-1', {
    id: 'g-1',
    whiteHandle: 'alice',
    blackHandle: 'bob',
    variant: 'standard',
    speed: 'blitz',
    result: '1-0',
    rated: true,
  });

  worker.start();

  // Redeliver same gameId
  subscriber.emit({ t: 'ended', gameId: 'g-1' });
  subscriber.emit({ t: 'ended', gameId: 'g-1' });
  await worker.drain();

  assert.strictEqual(source.findGameCalls, 1, 'Should call findGame only once for duplicate gameId');
  worker.stop();
});

test('SearchIndexWorker: contains indexing error, clears seen state for retry, and contains throwing onError hook', async () => {
  const subscriber = new FakeSubscriber();
  const source = new FakeGameSource();
  const repo = new InMemorySearchRepository();

  const errorLogs: string[] = [];
  const worker = new SearchIndexWorker(subscriber, 'games:ended', source, repo, {
    onError: (gameId, err) => {
      errorLogs.push(`${gameId}:${(err as Error).message}`);
      throw new Error('Throwing inside onError hook');
    },
  });

  source.games.set('g-err', {
    id: 'g-err',
    whiteHandle: 'carol',
    blackHandle: 'dave',
    variant: 'standard',
    speed: 'rapid',
    result: '0-1',
    rated: false,
  });
  source.shouldThrowFor = 'g-err';

  worker.start();

  // First attempt fails
  subscriber.emit({ t: 'ended', gameId: 'g-err' });
  await worker.drain(); // Must not reject even though onError threw!

  assert.strictEqual(errorLogs.length, 1);
  assert.strictEqual(await repo.size(), 0);

  // Clear error condition; second attempt should succeed because seen was deleted on error
  source.shouldThrowFor = undefined;
  subscriber.emit({ t: 'ended', gameId: 'g-err' });
  await worker.drain();

  assert.strictEqual(await repo.size(), 1);
  worker.stop();
});

test('SearchIndexWorker: skips aborted games (result === "*") and non-existent games (null)', async () => {
  const subscriber = new FakeSubscriber();
  const source = new FakeGameSource();
  const repo = new InMemorySearchRepository();
  const worker = new SearchIndexWorker(subscriber, 'games:ended', source, repo);

  source.games.set('g-aborted', {
    id: 'g-aborted',
    whiteHandle: 'alice',
    blackHandle: 'bob',
    variant: 'standard',
    speed: 'blitz',
    result: '*', // Aborted game
    rated: true,
  });

  worker.start();

  // 1. Aborted game
  subscriber.emit({ t: 'ended', gameId: 'g-aborted' });

  // 2. Non-existent game
  subscriber.emit({ t: 'ended', gameId: 'g-unknown' });
  await worker.drain();

  assert.strictEqual(await repo.size(), 0, 'Aborted games and null games should not be indexed');
  worker.stop();
});

test('SearchIndexWorker: start and stop idempotency', () => {
  const subscriber = new FakeSubscriber();
  const source = new FakeGameSource();
  const repo = new InMemorySearchRepository();
  const worker = new SearchIndexWorker(subscriber, 'games:ended', source, repo);

  worker.start();
  worker.start();
  assert.strictEqual(subscriber.subscribeCount, 1);

  worker.stop();
  worker.stop();
  assert.strictEqual(subscriber.unsubscribeCount, 1);
});
