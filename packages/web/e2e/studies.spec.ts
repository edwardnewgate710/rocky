/**
 * E2E tests for the studies viewer section (studies list, detail, chapter, move tree, board interaction).
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend — M14 acceptance gate');

test('user can browse studies, open a chapter, view mainline and variations, and click a move to update board position', async ({ page, request }) => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const studyName = `Ruy Lopez Study ${suffix}`;
  const pgn = '[Event "Ruy Lopez Chapter"]\n[White "Kasparov"]\n[Black "Deep Blue"]\n\n1. e4 { King\'s pawn opening. } e5 2. Nf3 $1 Nc6 (2... Nf6 $2 3. Nxe5 d6) 3. Bb5 *';

  // Seed a public study with chapter via bridge route POST /e2e/studies
  const seedRes = await request.post('/e2e/studies', {
    data: {
      name: studyName,
      description: 'Masterclass on the Ruy Lopez opening.',
      pgn,
    },
  });
  expect(seedRes.ok()).toBeTruthy();
  const seeded = await seedRes.json();
  expect(seeded.studyId).toBeTruthy();
  expect(seeded.chapterId).toBeTruthy();

  // Navigate to /studies
  await page.goto('/studies');
  await expect(page.locator('#studies')).toBeVisible({ timeout: 15_000 });

  // Study row should be present in the list
  const studyRow = page
    .locator('#study-list .panel-row')
    .filter({ has: page.getByRole('link', { name: studyName }) });
  await expect(studyRow).toBeVisible({ timeout: 15_000 });

  // Click on the study link
  await studyRow.getByRole('link', { name: studyName }).click();

  // URL should be /studies/:id
  await expect(page).toHaveURL(`/studies/${seeded.studyId}`);
  await expect(page.locator('#study')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#study-name')).toHaveText(studyName);

  // Chapter name returned by chapterNameFor for "Kasparov" vs "Deep Blue" is "Kasparov vs Deep Blue"
  const expectedChapterName = 'Kasparov vs Deep Blue';

  // Chapter row should be visible in chapter list
  const chapterRow = page
    .locator('#study-chapters .panel-row')
    .filter({ has: page.getByRole('link', { name: expectedChapterName }) });
  await expect(chapterRow).toBeVisible({ timeout: 15_000 });

  // Click chapter link
  await chapterRow.getByRole('link', { name: expectedChapterName }).click();

  // URL should be /studies/:id/chapters/:chapterId
  await expect(page).toHaveURL(`/studies/${seeded.studyId}/chapters/${seeded.chapterId}`);
  await expect(page.locator('#study-chapter')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#chapter-name')).toHaveText(expectedChapterName);

  // Verify Move Notation Pane
  const notationTree = page.locator('#chapter-tree');
  await expect(notationTree).toBeVisible();

  // Pin exact move counts to guard against duplicate rendering (A1)
  const totalMoves = notationTree.locator('button.notation-move');
  await expect(totalMoves).toHaveCount(8); // 5 mainline + 3 variation moves

  const variationMoves = notationTree.locator('.notation-variation button.notation-move');
  await expect(variationMoves).toHaveCount(3); // 2... Nf6?, 3. Nxe5, d6

  // Check mainline move 2. Nf3! button by accessible role & name
  const moveNf3 = page.getByRole('button', { name: 'Move 2 White Nf3!' });
  await expect(moveNf3).toBeVisible();

  // Check variation move 2... Nf6? button by accessible role & name
  const moveNf6Var = page.getByRole('button', { name: 'Move 2 Black Nf6?' });
  await expect(moveNf6Var).toBeVisible();

  // Verify board square e4 has no white pawn initially (starting position)
  const boardEl = page.locator('#chapter-board');
  await expect(boardEl).toBeVisible();

  // Click on move 2. Nf3! button in the notation tree
  await moveNf3.click();

  // Move 2. Nf3! button should now have active class
  await expect(moveNf3).toHaveClass(/active/);

  // Board position should update: square f3 should now hold white knight (cb-p-wn)
  const squareF3 = boardEl.locator('[data-square="f3"] .cb-piece');
  await expect(squareF3).toHaveClass(/cb-p-wn/, { timeout: 15_000 });
});
