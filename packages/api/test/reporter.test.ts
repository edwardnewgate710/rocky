/**
 * Production TournamentResultReporter coverage (ADR-0025): startup
 * rehydration, discovery of games launched by other processes via `scan()`
 * (what the periodic timer calls), aborted-game relaunch, and stop().
 * Hermetic: in-memory PubSub + repositories, no timers (scanIntervalMs: 0).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { InMemoryPubSub, gameChannel } from '@chess-platform/realtime-gateway';
import { InMemoryTournamentsRepository } from '../src/fakes';
import { ArenaService } from '../src/tournament/arena.service';
import { TournamentService } from '../src/tournament/service';
import { InMemoryGameLauncher } from '../src/tournament/launcher';
import { TournamentResultReporter } from '../src/tournament/reporter';
import { uuidv7Generator } from '../src/ports/ids';

const TC = { kind: 'increment', initialMs: 60_000, incrementMs: 0, delayMs: 0 } as const;

interface Rig {
  pubsub: InMemoryPubSub;
  repo: InMemoryTournamentsRepository;
  arenaService: ArenaService;
  reporter: TournamentResultReporter;
}

function makeRig(): Rig {
  const pubsub = new InMemoryPubSub();
  const repo = new InMemoryTournamentsRepository();
  const launcher = new InMemoryGameLauncher(uuidv7Generator);
  const arenaService = new ArenaService(repo, launcher, () => 1_000);
  const tournamentService = new TournamentService(repo, launcher);
  const reporter = new TournamentResultReporter(pubsub, repo, tournamentService, arenaService, {
    scanIntervalMs: 0, // tests drive scan() directly instead of a timer
  });
  return { pubsub, repo, arenaService, reporter };
}

async function makeRunningArena(rig: Rig, id: string): Promise<string> {
  await rig.arenaService.create({ id, name: id, variant: 'standard', timeControl: TC, durationMs: 3_600_000 });
  await rig.arenaService.register(id, 'p1');
  await rig.arenaService.register(id, 'p2');
  await rig.arenaService.start(id, 1_000);
  const stored = await rig.repo.findById(id);
  const links = (stored!.snapshot.gameLinks ?? []) as [string, string][];
  assert.equal(links.length, 1);
  return links[0]![1];
}

function endGame(pubsub: InMemoryPubSub, gameId: string, result: '1-0' | '0-1' | '1/2-1/2' | '*'): void {
  pubsub.publish(gameChannel(gameId), {
    t: 'ended',
    gameId,
    result,
    termination: result === '*' ? 'aborted' : 'resignation',
    winner: result === '1-0' ? 'w' : result === '0-1' ? 'b' : null,
    serverTs: 1_000,
  });
}

/** The reporter records asynchronously off the PubSub callback. */
function settleAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('TournamentResultReporter (production)', () => {
  it('rehydrates in-flight games at startup and records their results', async () => {
    const rig = makeRig();
    // The tournament was started by "another process" BEFORE this reporter
    // existed — only the stored snapshot knows about the game.
    const gameId = await makeRunningArena(rig, 'boot-arena');

    await rig.reporter.start();
    endGame(rig.pubsub, gameId, '1-0');
    await settleAsync();

    const standings = await rig.arenaService.getStandings('boot-arena');
    assert.equal(standings.filter((s) => s.gamesPlayed === 1).length, 2);
    assert.equal(standings.filter((s) => s.wins === 1).length, 1);
    rig.reporter.stop();
  });

  it('discovers games launched after startup via scan()', async () => {
    const rig = makeRig();
    await rig.reporter.start(); // nothing running yet

    // An API replica starts a tournament AFTER the reporter booted; the
    // launcher callback never fires in this process.
    const gameId = await makeRunningArena(rig, 'late-arena');
    await rig.reporter.scan(); // what the periodic timer does

    endGame(rig.pubsub, gameId, '0-1');
    await settleAsync();

    const standings = await rig.arenaService.getStandings('late-arena');
    assert.equal(standings.filter((s) => s.gamesPlayed === 1).length, 2);
    rig.reporter.stop();
  });

  it('relaunches an aborted game and watches the replacement', async () => {
    const rig = makeRig();
    const gameId = await makeRunningArena(rig, 'abort-arena');
    await rig.reporter.start();

    endGame(rig.pubsub, gameId, '*');
    await settleAsync();

    // Abandon put both players back in the pool; reconcile launched a fresh
    // game under a new id.
    const stored = await rig.repo.findById('abort-arena');
    const links = (stored!.snapshot.gameLinks ?? []) as [string, string][];
    assert.equal(links.length, 1);
    const replacement = links[0]![1];
    assert.notEqual(replacement, gameId);

    // After a scan, the replacement is watched too: its result records.
    await rig.reporter.scan();
    endGame(rig.pubsub, replacement, '1/2-1/2');
    await settleAsync();
    const standings = await rig.arenaService.getStandings('abort-arena');
    assert.equal(standings.filter((s) => s.draws === 1).length, 2);
    rig.reporter.stop();
  });

  it('stop() unsubscribes everything: later broadcasts record nothing', async () => {
    const rig = makeRig();
    const gameId = await makeRunningArena(rig, 'stop-arena');
    await rig.reporter.start();
    rig.reporter.stop();

    endGame(rig.pubsub, gameId, '1-0');
    await settleAsync();

    const standings = await rig.arenaService.getStandings('stop-arena');
    assert.equal(standings.filter((s) => s.gamesPlayed === 0).length, 2);
  });
});
