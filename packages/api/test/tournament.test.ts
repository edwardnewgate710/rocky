import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { startHarness, type Harness } from './helpers';

describe('Tournament API', () => {
  let h: Harness;
  let userToken: string;
  let directorToken: string;
  let userId: string;
  let directorId: string;

  before(async () => {
    h = await startHarness();
    const u = await h.makeUser('alice');
    userToken = u.token;
    userId = u.userId;

    const d = await h.makeUser('bob_dir', ['user', 'tournament_director']);
    directorToken = d.token;
    directorId = d.userId;
  });

  after(async () => {
    await h.close();
  });

  it('rejects creation by non-director', async () => {
    const res = await h.json('POST', '/v1/tournaments', {
      token: userToken,
      body: { name: 'My Tourney', format: 'round_robin', variant: 'standard', timeControl: { kind: 'increment', initialMs: 300000, incrementMs: 2000, delayMs: 0 } },
    });
    assert.equal(res.status, 403);
  });

  it('allows creation by director', async () => {
    const res = await h.json('POST', '/v1/tournaments', {
      token: directorToken,
      body: { name: 'My Tourney', format: 'round_robin', variant: 'standard', timeControl: { kind: 'increment', initialMs: 300000, incrementMs: 2000, delayMs: 0 } },
    });
    if (res.status !== 201) console.error('round_robin creation error:', res.body);
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'My Tourney');
    assert.equal(res.body.format, 'round_robin');
    assert.equal(res.body.state, 'registration');
    assert.equal(res.body.participants.length, 0);
  });

  it('runs a full tournament lifecycle', async () => {
    // 1. Create a 3-round swiss
    const createRes = await h.json('POST', '/v1/tournaments', {
      token: directorToken,
      body: {
        name: 'Rapid Swiss',
        format: 'swiss',
        variant: 'standard',
        rounds: 3,
        timeControl: { kind: 'increment', initialMs: 600000, incrementMs: 5000, delayMs: 0 },
      },
    });
    if (createRes.status !== 201) console.error('swiss creation error:', createRes.body);
    assert.equal(createRes.status, 201);
    const tId = createRes.body.id;

    // 2. Register participants
    const u2 = await h.makeUser('charlie');
    const u3 = await h.makeUser('dave');

    // Director registers self
    await h.json('POST', `/v1/tournaments/${tId}/participants`, { token: directorToken });
    // User registers self
    await h.json('POST', `/v1/tournaments/${tId}/participants`, { token: userToken });
    // Director registers someone else
    await h.json('POST', `/v1/tournaments/${tId}/participants`, {
      token: directorToken,
      body: { playerId: u2.userId },
    });
    // Another user registers self
    await h.json('POST', `/v1/tournaments/${tId}/participants`, { token: u3.token });

    // Verify list
    const getRes = await h.json('GET', `/v1/tournaments/${tId}`);
    assert.equal(getRes.body.participants.length, 4);

    // 3. Start tournament
    const startRes = await h.json('POST', `/v1/tournaments/${tId}/start`, { token: directorToken });
    assert.equal(startRes.status, 200);
    assert.equal(startRes.body.state, 'running');

    // 4. Fetch rounds
    const roundsRes = await h.json('GET', `/v1/tournaments/${tId}/rounds`);
    assert.equal(roundsRes.status, 200);
    assert.equal(roundsRes.body.length, 1);
    const round1 = roundsRes.body[0];
    assert.equal(round1.roundIndex, 0);
    assert.equal(round1.pairings.length, 2);

    // 5. Record results
    const r1Res = await h.json('POST', `/v1/tournaments/${tId}/rounds/0/results`, {
      token: directorToken,
      body: { pairingIndex: 0, result: 'white_win' },
    });
    assert.equal(r1Res.status, 200);

    const r2Res = await h.json('POST', `/v1/tournaments/${tId}/rounds/0/results`, {
      token: directorToken,
      body: { pairingIndex: 1, result: 'black_win' },
    });
    assert.equal(r2Res.status, 200);

    // After resolving all pairings, it should advance round
    const roundsRes2 = await h.json('GET', `/v1/tournaments/${tId}/rounds`);
    assert.equal(roundsRes2.body.length, 2);

    // 6. Check standings
    const standingsRes = await h.json('GET', `/v1/tournaments/${tId}/standings`);
    assert.equal(standingsRes.status, 200);
    assert.equal(standingsRes.body.length, 4);
    assert.equal(standingsRes.body[0].points, 1); // 1 win
    assert.equal(standingsRes.body[1].points, 1); // 1 win
    assert.equal(standingsRes.body[2].points, 0);
    assert.equal(standingsRes.body[3].points, 0);

    // 7. Check list summary
    const listRes = await h.json('GET', '/v1/tournaments');
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.length, 2); // My Tourney + Rapid Swiss
    assert.equal(listRes.body[0].id, tId); // Newest first
    assert.equal(listRes.body[0].state, 'running');
    assert.equal(listRes.body[0].participantCount, 4);
  });
});
