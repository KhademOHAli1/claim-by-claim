import { expect, test } from '@playwright/test';

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  reducedMotion: 'reduce',
});

test('changing mobile player size preserves the playing video and its position', async ({
  page,
}) => {
  await page.goto('/');
  const workspace = page.locator('.mobile-workspace');
  const video = workspace.locator('video');
  const stage = workspace.locator('.video-stage');
  const sizeButton = (name: string) =>
    workspace.getByRole('button', { name, exact: true });
  const transcriptButton = workspace
    .getByRole('navigation', { name: 'Claim information' })
    .getByRole('button', { name: 'Transcript' });

  await expect(workspace).toHaveAttribute('data-player-size', 'balanced');
  const transcript = workspace.getByRole('region', { name: 'Transcript and claims' });
  await expect(transcript).toBeVisible();
  const balancedHeight = (await stage.boundingBox())!.height;
  const originalVideo = (await video.elementHandle())!;
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
    .toBeGreaterThan(1);
  await workspace.getByRole('button', { name: 'Play', exact: true }).tap();
  const currentTime = () => video.evaluate((element: HTMLVideoElement) => element.currentTime);
  await expect.poll(currentTime).toBeGreaterThan(0.2);

  const initialTime = await currentTime();
  await sizeButton('Compact').tap();
  await expect(workspace).toHaveAttribute('data-player-size', 'compact');
  await expect.poll(async () => (await stage.boundingBox())!.height).toBeLessThan(balancedHeight);
  await sizeButton('Expanded').tap();
  await expect(workspace).toHaveAttribute('data-player-size', 'expanded');
  await expect(workspace).toHaveAttribute('data-panel', 'closed');
  await expect.poll(async () => (await stage.boundingBox())!.height).toBeGreaterThan(balancedHeight);
  await transcriptButton.tap();
  await expect(transcript).toBeVisible();
  await sizeButton('Balanced').tap();
  await expect(workspace).toHaveAttribute('data-player-size', 'balanced');
  await expect(workspace.locator('video')).toHaveCount(1);
  expect(
    await originalVideo.evaluate((element) => element === document.querySelector('video')),
  ).toBe(true);
  await expect.poll(currentTime).toBeGreaterThan(initialTime);
  expect(await video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
});

test('compact transcript holds the inspected claim and opens the exact source page', async ({
  page,
}) => {
  await page.goto('/#C003');
  const workspace = page.locator('.mobile-workspace');
  await workspace.getByRole('button', { name: 'Compact', exact: true }).tap();
  const cue = workspace.locator('.transcript-cue').filter({ hasText: 'She is not an American citizen' });
  await expect(cue).toHaveClass(/\bactive\b/);
  await cue.getByRole('button', { name: /2 fact checks/i }).tap();

  const inlineFinding = cue.locator('.mobile-inline-finding');
  await expect(inlineFinding).toContainText('Her citizenship status');
  await expect(inlineFinding).toContainText('Contradicted');
  await workspace.getByRole('slider', { name: 'Video position' }).fill('40');
  await expect
    .poll(() => workspace.locator('video').evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeCloseTo(40, 0);
  await expect(inlineFinding).toContainText('Her citizenship status');

  await inlineFinding.getByRole('button', { name: /sources/i }).tap();
  await workspace.getByRole('button', { name: /House history/ }).tap();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.document-preview img')).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Arrival and citizenship · PDF page 714' }))
    .toHaveAttribute('href', /govinfo\.gov.*\.pdf#page=714$/);
});

test('touch scrolling pauses transcript follow, and the layout fits a 320px screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 667 });
  await page.goto('/#C017');
  const workspace = page.locator('.mobile-workspace');
  await workspace.getByRole('button', { name: 'Compact', exact: true }).tap();
  const transcript = workspace.getByRole('region', { name: 'Transcript and claims' });
  await expect(transcript).toBeVisible();
  const scroller = workspace.locator('.transcript-scroll');
  const touch = await page.context().newCDPSession(page);
  const { x, y, width, height } = (await scroller.boundingBox())!;
  const touchX = Math.floor(x + width / 2);
  const touchY = Math.floor(y + height * 0.75);
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: touchX, y: touchY }],
  });
  for (const distance of [30, 60, 90]) {
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: touchX, y: touchY - distance }],
    });
  }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const resume = workspace.getByRole('button', { name: 'Jump to current time' });
  await expect(resume).toBeVisible();
  await resume.tap();
  await expect(workspace.getByRole('button', { name: 'Following' })).toBeVisible();
  await expect(workspace.locator('.transcript-cue.active')).toBeInViewport();
  const widths = await workspace.evaluate((element) => ({
    content: element.scrollWidth,
    visible: element.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(widths.content).toBe(widths.visible);
  expect(widths.document).toBe(320);
});
