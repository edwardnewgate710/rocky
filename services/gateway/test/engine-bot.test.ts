import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GameAuthority,
  InMemoryPubSub,
  LocalCommandRouter,
  gameChannel,
} from '@chess-platform/realtime-gateway';
import type {
  AnalysisProvider,
  AnalysisRequest,
  EngineCapabilities,
  EngineResult,
  PlayRequest,
  PlayResult,
} from '@chess-platform/engine';
import type { Counter, Histogram, Logger, LogFields } from '@chess-platform/api';
import { BOT_ACCOUNTS } from '@chess-platform/api';
import { EngineBotMover } from '../src/engine-bot.js';

class FakeAnalysisProvider implements AnalysisProvider {
  public playCalls: PlayRequest[] = [];
  public shouldFail = false;
  public responseMove = 'e7e5';

  async analyze(_request: AnalysisRequest): Promise<readonly EngineResult[]> {
    return [];
  }

  async play(request: PlayRequest): Promise<PlayResult> {
    this.playCalls.push(request);
    if (this.shouldFail) {
      throw new Error('Engine UCI subprocess crashed');
    }
    return { move: this.responseMove };
  }

  capabilitiesFor(_variant: string): EngineCapabilities | undefined {
    return undefined;
  }
}

class FakeCounter implements Counter {
  public count = 0;
  inc(n = 1): void {
    this.count += n;
  }
}

class FakeHistogram implements Histogram {
  public observations: number[] = [];
  observe(value: number): void {
    this.observations.push(value);
  }
}

class CapturingLogger implements Logger {
  public warnings: { msg: string; fields?: LogFields }[] = [];

  debug(_msg: string, _fields?: LogFields): void {}
  info(_msg: string, _fields?: LogFields): void {}
  warn(msg: string, fields?: LogFields): void {
    this.warnings.push({ msg, fields });
  }
  error(_msg: string, _fields?: LogFields): void {}
  child(_bindings: LogFields): Logger {
    return this;
  }
}

test('EngineBotMover single-node: bot plays a response move after human move', async () => {
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub);
  const router = new LocalCommandRouter(authority);
  const provider = new FakeAnalysisProvider();
  provider.responseMove = 'e7e5';
  const moveSecondsHistogram = new FakeHistogram();

  const mover = new EngineBotMover({
    authority,
    router,
    pubsub,
    provider,
    moveSecondsHistogram,
  });

  const botUser = BOT_ACCOUNTS[0]!; // gambit-novice
  const humanId = 'human-player-1';
  const gameId = '00000000-0000-7000-8000-000000000010';

  await authority.createGame({
    gameId,
    variant: 'standard',
    timeControl: { kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 },
    players: { white: humanId, black: botUser.userId },
    rated: false,
  });

  mover.registerGame(gameId);

  // Human plays 1. e4 — pub/sub broadcast triggers bot move attempt
  await authority.apply(gameId, humanId, { kind: 'move', uci: 'e2e4' });
  await mover.attemptMove(gameId);

  const state = authority.getState(gameId);
  assert.equal(state.ply, 2, 'state must advance to ply 2 after bot reply');
  assert.equal(provider.playCalls.length, 1, 'provider.play must be called once');
  assert.equal(provider.playCalls[0]!.priority, 0, 'must use JobPriority.BotMove (0)');
  assert.deepEqual(provider.playCalls[0]!.strength, botUser.strength);

  assert.equal(moveSecondsHistogram.observations.length, 1, 'histogram must record one observation');
  assert.ok(Number.isFinite(moveSecondsHistogram.observations[0]), 'observation must be a finite number');
  assert.ok(moveSecondsHistogram.observations[0]! >= 0, 'observation duration must be non-negative');

  mover.stop();
});

test('EngineBotMover: does not issue a command when it is not the bot turn', async () => {
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub);
  const router = new LocalCommandRouter(authority);
  const provider = new FakeAnalysisProvider();

  const mover = new EngineBotMover({
    authority,
    router,
    pubsub,
    provider,
  });

  const botUser = BOT_ACCOUNTS[0]!;
  const humanId = 'human-player-1';
  const gameId = '00000000-0000-7000-8000-000000000011';

  await authority.createGame({
    gameId,
    variant: 'standard',
    timeControl: { kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 },
    players: { white: humanId, black: botUser.userId },
    rated: false,
  });

  // Ply 0: human (White) to move. Attempting move for bot (Black) should produce no command.
  await mover.attemptMove(gameId);

  const state = authority.getState(gameId);
  assert.equal(state.ply, 0, 'state remains at ply 0');
  assert.equal(provider.playCalls.length, 0, 'engine play was not invoked');

  mover.stop();
});

test('EngineBotMover: bot plays White at ply 0 on registration', async () => {
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub);
  const router = new LocalCommandRouter(authority);
  const provider = new FakeAnalysisProvider();
  provider.responseMove = 'e2e4';

  const mover = new EngineBotMover({
    authority,
    router,
    pubsub,
    provider,
  });

  const botUser = BOT_ACCOUNTS[0]!; // bot is White
  const humanId = 'human-player-2';
  const gameId = '00000000-0000-7000-8000-000000000012';

  await authority.createGame({
    gameId,
    variant: 'standard',
    timeControl: { kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 },
    players: { white: botUser.userId, black: humanId },
    rated: false,
  });

  // Registering game triggers immediate move for White
  mover.registerGame(gameId);
  await mover.attemptMove(gameId);

  const state = authority.getState(gameId);
  assert.equal(state.ply, 1, 'bot White moves at ply 0 without prior broadcast');
  assert.equal(provider.playCalls.length, 1);

  mover.stop();
});

test('EngineBotMover: unsubscribes and stops after terminal game state', async () => {
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub);
  const router = new LocalCommandRouter(authority);
  const provider = new FakeAnalysisProvider();

  const mover = new EngineBotMover({
    authority,
    router,
    pubsub,
    provider,
  });

  const botUser = BOT_ACCOUNTS[0]!;
  const humanId = 'human-player-1';
  const gameId = '00000000-0000-7000-8000-000000000013';

  await authority.createGame({
    gameId,
    variant: 'standard',
    timeControl: { kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 },
    players: { white: humanId, black: botUser.userId },
    rated: false,
  });

  mover.registerGame(gameId);

  // Human resigns (game over) — pub/sub broadcast triggers unregister
  await authority.apply(gameId, humanId, { kind: 'resign' });

  const state = authority.getState(gameId);
  assert.equal(state.status.over, true);
  assert.equal(provider.playCalls.length, 0, 'no moves attempted after game over');

  mover.stop();
});

test('EngineBotMover: engine failure increments failure counter, logs warning, and keeps process alive', async () => {
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub);
  const router = new LocalCommandRouter(authority);
  const provider = new FakeAnalysisProvider();
  provider.shouldFail = true;

  const failuresCounter = new FakeCounter();
  const movesCounter = new FakeCounter();
  const logger = new CapturingLogger();

  const mover = new EngineBotMover({
    authority,
    router,
    pubsub,
    provider,
    failuresCounter,
    movesCounter,
    logger,
  });

  const botUser = BOT_ACCOUNTS[0]!;
  const humanId = 'human-player-1';
  const gameId = '00000000-0000-7000-8000-000000000014';

  await authority.createGame({
    gameId,
    variant: 'standard',
    timeControl: { kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 },
    players: { white: humanId, black: botUser.userId },
    rated: false,
  });

  mover.registerGame(gameId);

  // Human plays 1. e4 — pub/sub broadcast triggers move attempt
  await authority.apply(gameId, humanId, { kind: 'move', uci: 'e2e4' });

  assert.equal(failuresCounter.count, 1, 'failure counter must be incremented');
  assert.equal(movesCounter.count, 0, 'moves counter must not be incremented');
  assert.equal(logger.warnings.length, 1, 'warning must be logged');
  assert.ok(logger.warnings[0]!.msg.includes(gameId));

  const state = authority.getState(gameId);
  assert.equal(state.ply, 1, 'state remains untouched at ply 1');

  mover.stop();
});

test('EngineBotMover: unregisters when the bot\'s own move ends the game', async () => {
  // Regression: the broadcast caused by the bot's own routed move is delivered synchronously,
  // while `doMove` is still in flight. Coalescing that trigger into the in-flight promise and
  // dropping it left a finished game subscribed forever, because nothing re-examined the state
  // after the move that ended it. Fool's mate is the shortest game the bot can end itself.
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub);
  const router = new LocalCommandRouter(authority);
  const provider = new FakeAnalysisProvider();

  const mover = new EngineBotMover({ authority, router, pubsub, provider });

  const botUser = BOT_ACCOUNTS[0]!;
  const humanId = 'human-player-3';
  const gameId = '00000000-0000-7000-8000-000000000015';

  await authority.createGame({
    gameId,
    variant: 'standard',
    timeControl: { kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 },
    players: { white: humanId, black: botUser.userId },
    rated: false,
  });

  mover.registerGame(gameId);
  assert.equal(pubsub.subscriberCount(gameChannel(gameId)), 1, 'mover subscribed on registration');

  provider.responseMove = 'e7e5';
  await authority.apply(gameId, humanId, { kind: 'move', uci: 'f2f3' });
  await mover.attemptMove(gameId);

  provider.responseMove = 'd8h4'; // Qh4#
  await authority.apply(gameId, humanId, { kind: 'move', uci: 'g2g4' });
  await mover.attemptMove(gameId);

  const state = authority.getState(gameId);
  assert.equal(state.status.over, true, 'the bot delivered mate');
  assert.equal(
    pubsub.subscriberCount(gameChannel(gameId)),
    0,
    'mover must unsubscribe after the move that ended the game',
  );

  mover.stop();
});
