/**
 * E2E tests for the Teams UI.
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 */
import { test, expect, type BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend — M14 acceptance gate');

test('a second player finds a public team, joins it, and appears in the member list', async ({ browser, request }) => {
  let ownerCtx: BrowserContext | undefined;
  let joinerCtx: BrowserContext | undefined;

  try {
    // Created inside the try so a throw mid-creation still reaches the finally cleanup, matching
    // game-presence.spec.ts and messages.spec.ts.
    ownerCtx = await browser.newContext();
    joinerCtx = await browser.newContext();
    const joinerPage = await joinerCtx.newPage();

    const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
    const ownerHandle = `tm-o-${suffix}`;
    const joinerHandle = `tm-j-${suffix}`;
    const password = 'test-password-teams-123';

    const regOwner = await request.post('/v1/auth/register', { data: { handle: ownerHandle, password } });
    expect(regOwner.ok()).toBeTruthy();
    const ownerAuth = await regOwner.json();

    const regJoiner = await request.post('/v1/auth/register', { data: { handle: joinerHandle, password } });
    expect(regJoiner.ok()).toBeTruthy();
    const joinerAuth = await regJoiner.json();

    // The team name is unique per run: the harness index and repositories are shared across
    // parallel workers, so asserting on "the first row" would be a race against other specs.
    const teamName = `Team ${suffix}`;
    const createResp = await request.post('/v1/teams', {
      data: { name: teamName, slug: `team-${suffix}`, description: 'An e2e team', visibility: 'public' },
      headers: { Authorization: `Bearer ${ownerAuth.tokens.accessToken}` },
    });
    expect(createResp.ok()).toBeTruthy();
    const team = await createResp.json();

    await joinerCtx.addCookies([{
      name: 'gambit_refresh',
      value: joinerAuth.tokens.refreshToken,
      domain: 'localhost',
      path: '/v1/auth',
      httpOnly: true,
      secure: false,
      sameSite: 'Strict' as const,
    }]);
    await joinerPage.addInitScript(
      ({ handle, uid }) => {
        localStorage.setItem('gambit-session', JSON.stringify({ handle, userId: uid }));
      },
      { handle: joinerHandle, uid: joinerAuth.user.id },
    );

    // 1. The team is discoverable in the list.
    await joinerPage.goto('/teams');
    await expect(joinerPage.locator('#teams')).toBeVisible({ timeout: 15_000 });
    const row = joinerPage.locator('#team-list .panel-row', { hasText: teamName });
    await expect(row).toBeVisible({ timeout: 15_000 });

    // 2. Opening it shows the team and offers Join, because it is public and the viewer is not a
    //    member. The owner appears in the member list by handle, which only happens if the batched
    //    resolvePlayers hydration ran.
    await row.locator('a').click();
    await expect(joinerPage).toHaveURL(new RegExp(`/teams/team-${suffix}$`), { timeout: 15_000 });
    await expect(joinerPage.locator('#team-name')).toHaveText(teamName, { timeout: 15_000 });
    await expect(joinerPage.locator('#team-members')).toContainText(ownerHandle, { timeout: 15_000 });

    const joinButton = joinerPage.locator('#team-actions button', { hasText: 'Join team' });
    await expect(joinButton).toBeVisible({ timeout: 15_000 });

    // 3. Joining adds the viewer to the members and flips the offered action to Leave.
    await joinButton.click();
    await expect(joinerPage.locator('#team-members')).toContainText(joinerHandle, { timeout: 15_000 });
    await expect(joinerPage.locator('#team-actions button', { hasText: 'Leave team' })).toBeVisible({ timeout: 15_000 });

    // 4. The team id round-trips: the URL carries the slug, the member call needs the id.
    expect(team.slug).toBe(`team-${suffix}`);
  } finally {
    await ownerCtx?.close();
    await joinerCtx?.close();
  }
});
