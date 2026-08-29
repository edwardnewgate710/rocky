/**
 * The variant a tournament is created with must be the variant its games are launched with, for
 * every variant that can be created — not just the two the command interface used to name.
 *
 * `CreateArenaCommand.variant` and `CreateTournamentCommand.variant` were declared
 * `'standard' | 'chess960'`, wrong in both directions: they excluded the five variants an arena or
 * a round-based tournament can genuinely run, and named the one M15 Increment 14 stopped anybody
 * creating. `routes.ts` cast into that union, so the compiler was silenced rather than satisfied.
 * Nothing branched on the field, so nothing was mishandled — but nothing proved it either, which is
 * what this file is for. M15 Increment 15.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { InMemoryTournamentsRepository } from '../src/fakes';
import { ArenaService } from '../src/tournament/arena.service';
import { TournamentService } from '../src/tournament/service';
import { InMemoryGameLauncher } from '../src/tournament/launcher';
import { uuidv7Generator } from '../src/ports/ids';
import { CREATABLE_VARIANTS } from '../src/domain';

const TC = { kind: 'increment', initialMs: 60_000, incrementMs: 0, delayMs: 0 } as const;

/**
 * A fresh repository, launcher and both services, wired as production wires them.
 *
 * Fresh per test rather than shared: `InMemoryGameLauncher.launched` accumulates every launch it
 * has ever seen, and these tests assert over the whole array precisely so an extra launch under the
 * wrong variant cannot hide behind a correct one. Sharing the rig would let one test's games leak
 * into the next test's assertions and turn that strictness into noise.
 */
function makeRig() {
  const repo = new InMemoryTournamentsRepository();
  const launcher = new InMemoryGameLauncher(uuidv7Generator);
  return {
    repo,
    launcher,
    arenaService: new ArenaService(repo, launcher, () => 1_000),
    tournamentService: new TournamentService(repo, launcher),
  };
}

describe('tournament variant contract', () => {
  it('an arena keeps a non-standard variant and launches its games with it', async () => {
    // `atomic`: a real rule set, and one the old union said could not reach here.
    const rig = makeRig();
    await rig.arenaService.create({
      id: 'arena-atomic',
      name: 'Atomic Arena',
      variant: 'atomic',
      timeControl: TC,
      durationMs: 3_600_000,
    });
    await rig.arenaService.register('arena-atomic', 'p1');
    await rig.arenaService.register('arena-atomic', 'p2');
    await rig.arenaService.start('arena-atomic', 1_000);

    const stored = await rig.repo.findById('arena-atomic');
    assert.equal(stored?.snapshot.config.variant, 'atomic', 'the stored config keeps the variant');

    assert.ok(rig.launcher.launched.length > 0, 'starting the arena launched a game');
    for (const launch of rig.launcher.launched) {
      assert.equal(launch.variant, 'atomic', 'and the game was launched under the same rule set');
    }
  });

  it('a round-based tournament keeps a non-standard variant and launches its games with it', async () => {
    // The same defect lived on `CreateTournamentCommand`, so the round-based path needs its own
    // proof rather than inheriting the arena's.
    const rig = makeRig();
    await rig.tournamentService.create({
      id: 'rr-threecheck',
      name: 'Three-Check Round Robin',
      format: 'round_robin',
      variant: 'threecheck',
      timeControl: TC,
    });
    await rig.tournamentService.register('rr-threecheck', 'p1');
    await rig.tournamentService.register('rr-threecheck', 'p2');
    await rig.tournamentService.start('rr-threecheck');

    const stored = await rig.repo.findById('rr-threecheck');
    assert.equal(stored?.snapshot.config.variant, 'threecheck');

    assert.ok(rig.launcher.launched.length > 0, 'starting the tournament launched a game');
    for (const launch of rig.launcher.launched) {
      assert.equal(launch.variant, 'threecheck');
    }
  });

  it('every creatable variant survives arena creation', async () => {
    // The point of the fix is that the accepted set is one set, not a hand-copied subset. Driving
    // the real `CREATABLE_VARIANTS` means a variant added there tomorrow is covered here without
    // anyone remembering to extend this list — and a narrowing reintroduced on the command
    // interface fails to compile against it.
    for (const variant of CREATABLE_VARIANTS) {
      const rig = makeRig();
      await rig.arenaService.create({
        id: `arena-${variant}`,
        name: variant,
        variant,
        timeControl: TC,
        durationMs: 3_600_000,
      });
      const stored = await rig.repo.findById(`arena-${variant}`);
      assert.equal(stored?.snapshot.config.variant, variant, `${variant} must survive creation`);
    }
  });

  it('chess960 is creatable here, and arrives through the shared set rather than a special case', async () => {
    // ADR-0123 refused it and ADR-0137 restores it. What this pins is that it arrives the same way
    // every other variant does: through `CREATABLE_VARIANTS`, which the loop above already drives, so
    // there is no chess960-shaped branch on the tournament command interface to go stale.
    assert.ok(
      CREATABLE_VARIANTS.includes('chess960'),
      'chess960 is in the creatable set, so the tournament routes accept it like any other variant',
    );

    const rig = makeRig();
    await rig.arenaService.create({
      id: 'arena-960',
      name: 'chess960',
      variant: 'chess960',
      timeControl: TC,
      durationMs: 3_600_000,
    });
    assert.equal((await rig.repo.findById('arena-960'))?.snapshot.config.variant, 'chess960');
  });
});
