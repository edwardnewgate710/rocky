import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryEventStore } from '@chess-platform/persistence';
import { InMemoryTournamentsRepository } from '../src/fakes';
import { DurableGameLauncher, launchGameId } from '../src/tournament/durable-launcher';
import { DurableTournamentLiveView } from '../src/tournament/durable-live-view';
import type { LaunchInput } from '../src/tournament/launcher';

const input: LaunchInput = {
  tournamentId: 't1',
  matchId: '0-0',
  white: 'alice',
  black: 'bob',
  variant: 'standard',
  timeControl: { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'increment' },
  attempt: 0,
};

test('durable launcher creates one playable event log and is idempotent across instances', async () => {
  const events = new InMemoryEventStore();
  const clock = { now: () => 1234 };
  const first = new DurableGameLauncher(events, clock);
  const second = new DurableGameLauncher(events, clock);

  const [a, b] = await Promise.all([first.launch(input), second.launch(input)]);
  assert.equal(a.gameId, b.gameId);
  assert.equal(a.gameId, launchGameId(input));
  const log = await events.load(a.gameId);
  assert.equal(log.length, 1);
  assert.equal(log[0]!.event.type, 'GameCreated');
});

test('durable live view reconstructs linked active games from the event log', async () => {
  const events = new InMemoryEventStore();
  const tournaments = new InMemoryTournamentsRepository();
  const launcher = new DurableGameLauncher(events, { now: () => 1234 });
  const { gameId } = await launcher.launch(input);
  await tournaments.save({
    config: {
      id: 't1', name: 'Test', format: 'round_robin', variant: 'standard',
      timeControl: input.timeControl as { initialMs: number; incrementMs: number; delayMs: number; kind: 'increment' },
    },
    state: 'running',
    participants: ['alice', 'bob'],
    rounds: [],
    results: [],
    pairingsByMatchId: [],
    gameLinks: [['0-0', gameId]],
  }, 0);

  const boards = await new DurableTournamentLiveView(tournaments, events).activeGames('t1');
  assert.equal(boards.length, 1);
  assert.equal(boards[0]!.gameId, gameId);
  assert.equal(boards[0]!.fenHash.length, 12);
});
