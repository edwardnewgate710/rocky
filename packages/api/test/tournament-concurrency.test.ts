/**
 * Optimistic-concurrency coverage for tournament persistence (ADR-0025):
 * the repository rejects stale writes, and the service retry loop makes two
 * concurrent result recordings BOTH survive (the lost-update scenario that a
 * blind upsert silently corrupts).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { VersionConflictError } from '@chess-platform/persistence';
import { InMemoryTournamentsRepository } from '../src/fakes';
import { ArenaService } from '../src/tournament/arena.service';
import { InMemoryGameLauncher } from '../src/tournament/launcher';
import { uuidv7Generator } from '../src/ports/ids';

const TC = { kind: 'increment', initialMs: 60_000, incrementMs: 0, delayMs: 0 } as const;

function makeArenaService(repo: InMemoryTournamentsRepository): ArenaService {
  return new ArenaService(repo, new InMemoryGameLauncher(uuidv7Generator), () => 1_000);
}

describe('tournament optimistic concurrency', () => {
  it('in-memory repository rejects stale-version saves', async () => {
    const repo = new InMemoryTournamentsRepository();
    const service = makeArenaService(repo);
    await service.create({ id: 'a1', name: 'CAS Arena', variant: 'standard', timeControl: TC, durationMs: 3_600_000 });

    const stored = await repo.findById('a1');
    assert.ok(stored);
    assert.equal(stored.version, 1);

    // A write with the current version succeeds and bumps the version.
    await repo.save(stored.snapshot, stored.version);
    const bumped = await repo.findById('a1');
    assert.equal(bumped!.version, 2);

    // Replaying the previous version is a conflict, and creating over an
    // existing id (expectedVersion 0) is too.
    await assert.rejects(repo.save(stored.snapshot, stored.version), VersionConflictError);
    await assert.rejects(repo.save(stored.snapshot, 0), VersionConflictError);
  });

  it('two concurrent result recordings both survive', async () => {
    const repo = new InMemoryTournamentsRepository();
    const service = makeArenaService(repo);
    await service.create({ id: 'a2', name: 'Race Arena', variant: 'standard', timeControl: TC, durationMs: 3_600_000 });
    for (const p of ['p1', 'p2', 'p3', 'p4']) await service.register('a2', p);
    await service.start('a2', 1_000);

    // Starting a 4-player arena launches two games.
    const started = await repo.findById('a2');
    const links = (started!.snapshot.gameLinks ?? []) as [string, string][];
    assert.equal(links.length, 2);
    const [g1, g2] = [links[0]![1], links[1]![1]];

    // Both games end "at the same time": the two service calls interleave at
    // their awaits, so without CAS + retry the second save would silently
    // overwrite the first result.
    await Promise.all([
      service.recordResultByGame('a2', g1, 'white_win'),
      service.recordResultByGame('a2', g2, 'black_win'),
    ]);

    const standings = await service.getStandings('a2');
    assert.equal(standings.length, 4);
    for (const s of standings) {
      assert.equal(s.gamesPlayed, 1, `player ${s.playerId} lost a recorded result`);
    }
    assert.equal(standings.filter((s) => s.wins === 1).length, 2);
    assert.equal(standings.filter((s) => s.losses === 1).length, 2);
  });
});
