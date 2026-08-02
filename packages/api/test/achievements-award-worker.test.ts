import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryAchievementsRepository, type FinishedGameSummary } from '@chess-platform/achievements';
import { AchievementsAwardWorker } from '../src/achievements/award-worker';

class FakeSubscriber {
  public handler?: (msg: unknown) => void;
  public subscribedChannel?: string;
  public unsubscribed = false;

  subscribe(channel: string, handler: (msg: unknown) => void): () => void {
    this.subscribedChannel = channel;
    this.handler = handler;
    return () => {
      this.unsubscribed = true;
    };
  }

  emit(msg: unknown): void {
    if (this.handler) {
      this.handler(msg);
    }
  }
}

class FakeGameSource {
  public games = new Map<string, FinishedGameSummary>();

  async findGame(id: string): Promise<FinishedGameSummary | null> {
    return this.games.get(id) ?? null;
  }
}

describe('AchievementsAwardWorker', () => {
  it('subscribes to channel and awards achievements on finished game events', async () => {
    const subscriber = new FakeSubscriber();
    const source = new FakeGameSource();
    const repo = new InMemoryAchievementsRepository();
    const errors: unknown[] = [];

    const worker = new AchievementsAwardWorker(subscriber, 'games:ended', source, repo, {
      onError: (_id, err) => errors.push(err),
    });

    const p1 = 'player-white';
    const p2 = 'player-black';

    source.games.set('game-1', {
      gameId: 'game-1',
      whitePlayerId: p1,
      blackPlayerId: p2,
      winnerPlayerId: p1,
      result: '1-0',
      speed: 'blitz',
      plyCount: 20,
    });

    worker.start();
    assert.equal(subscriber.subscribedChannel, 'games:ended');

    subscriber.emit({ t: 'ended', gameId: 'game-1' });
    await worker.drain();

    assert.equal(errors.length, 0);

    // p1 won
    const p1Summary = await repo.getSummary(p1);
    assert.ok(p1Summary.unlockedCount > 0);

    // p2 played
    const p2Summary = await repo.getSummary(p2);
    assert.ok(p2Summary.unlockedCount > 0);

    worker.stop();
    assert.equal(subscriber.unsubscribed, true);
  });

  it('contains errors when awarding fails and does not throw', async () => {
    const subscriber = new FakeSubscriber();
    const source = new FakeGameSource();
    const repo = new InMemoryAchievementsRepository();
    const errors: unknown[] = [];

    const worker = new AchievementsAwardWorker(subscriber, 'games:ended', source, repo, {
      onError: (_id, err) => errors.push(err),
    });

    // Mock findGame to throw error
    source.findGame = async () => {
      throw new Error('Database connection failed');
    };

    worker.start();
    subscriber.emit({ t: 'ended', gameId: 'game-failing' });
    await worker.drain();

    assert.equal(errors.length, 1);
    assert.equal((errors[0] as Error).message, 'Database connection failed');

    // Containment is not "the throw was swallowed" — it is that the NEXT game still gets awarded.
    // A worker that catches the error and then sits dead behind a broken subscription passes the
    // assertions above and fails at the only thing it was built to guarantee: that achievements,
    // which are decoration, can never take the game pipeline with them.
    source.findGame = async (id: string) => ({
      gameId: id,
      whitePlayerId: '018f3a5b-7c9d-7000-8000-0000000000a1',
      blackPlayerId: '018f3a5b-7c9d-7000-8000-0000000000a2',
      winnerPlayerId: '018f3a5b-7c9d-7000-8000-0000000000a1',
      result: '1-0',
    });

    subscriber.emit({ t: 'ended', gameId: 'game-after-failure' });
    await worker.drain();

    assert.equal(errors.length, 1, 'the recovered game must not report an error');
    const summary = await repo.getSummary('018f3a5b-7c9d-7000-8000-0000000000a1');
    assert.ok(summary.unlockedCount > 0, 'the subscription must survive a failed award');

    worker.stop();
  });

  it('still awards the second player when the first one fails', async () => {
    const subscriber = new FakeSubscriber();
    const source = new FakeGameSource();
    const repo = new InMemoryAchievementsRepository();
    const errors: unknown[] = [];

    const white = '018f3a5b-7c9d-7000-8000-0000000000b1';
    const black = '018f3a5b-7c9d-7000-8000-0000000000b2';

    source.findGame = async (id: string) => ({
      gameId: id,
      whitePlayerId: white,
      blackPlayerId: black,
      winnerPlayerId: white,
      result: '1-0',
    });

    // White's write fails — a deleted account, a transient error, anything. Black did nothing wrong
    // and must not lose the achievements from a game they played.
    const realAward = repo.award.bind(repo);
    repo.award = async (playerId, key, increment, at) => {
      if (playerId === white) {
        throw new Error('write failed for white');
      }
      return realAward(playerId, key, increment, at);
    };

    const worker = new AchievementsAwardWorker(subscriber, 'games:ended', source, repo, {
      onError: (_id, err) => errors.push(err),
    });
    worker.start();
    subscriber.emit({ t: 'ended', gameId: 'game-partial' });
    await worker.drain();

    const blackSummary = await repo.getSummary(black);
    assert.ok(blackSummary.unlockedCount > 0, "the other player's awards must land");
    assert.equal(errors.length, 1, 'the failure must still be reported, not swallowed');

    worker.stop();
  });

  it('ignores invalid event payloads defensively', async () => {
    const subscriber = new FakeSubscriber();
    const source = new FakeGameSource();
    const repo = new InMemoryAchievementsRepository();

    const worker = new AchievementsAwardWorker(subscriber, 'games:ended', source, repo);
    worker.start();

    // Invalid messages
    subscriber.emit(null);
    subscriber.emit('invalid');
    subscriber.emit({ t: 'move' });
    subscriber.emit({ t: 'ended', gameId: '' });

    await worker.drain();
    worker.stop();
  });
});
