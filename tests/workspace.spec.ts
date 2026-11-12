import { expect, test } from '@playwright/test';

test('the desktop workspace fits the viewport and keeps scroll inside panes', async ({
  page,
}) => {
  for (const size of [
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(size);
    await page.goto('/');
    await expect(page.locator('.dock-workspace .video-panel')).toBeVisible();
    const layout = await page.evaluate(() => ({
      viewport: { width: innerWidth, height: innerHeight },
      document: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
      panelBottoms: [...document.querySelectorAll('.panel')].map(
        (panel) => panel.getBoundingClientRect().bottom,
      ),
    }));
    expect(layout.document).toEqual(layout.viewport);
    expect(
      layout.panelBottoms.every((bottom) => bottom < size.height - 28),
    ).toBe(true);
    await page.locator('.transcript-scroll').hover();
    await page.mouse.wheel(0, 400);
    await expect
      .poll(() =>
        page.locator('.transcript-scroll').evaluate((el) => el.scrollTop),
      )
      .toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  }
});

test('video playback and seeking select the relevant fact check', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect
    .poll(() =>
      page
        .locator('video')
        .evaluate((video: HTMLVideoElement) => video.readyState),
    )
    .toBeGreaterThan(1);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator('video')
        .evaluate((video: HTMLVideoElement) => video.currentTime),
    )
    .toBeGreaterThan(0.3);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.locator('input[aria-label="Video position"]').fill('40');
  await expect(page.locator('.finding-panel h2')).toHaveText(
    'Does this mean prison for life?',
  );
  await expect(page.locator('.finding-panel .verdict-badge')).toHaveText(
    'Contradicted',
  );
  await expect(page.locator('.finding-analysis-grid')).toContainText(
    'finite maximum terms',
  );
  await page.getByRole('tab', { name: /Claims/ }).click();
  await page.getByLabel('Filter claims by verdict color').selectOption('green');
  await expect(page.locator('.claim-list-row')).toHaveCount(6);
  await page.locator('.claim-list-row').filter({ hasText: 'C030' }).click();
  await expect(page.locator('.finding-panel h2')).toHaveText(
    'The 2024 vice-presidential candidate',
  );
  await expect
    .poll(() =>
      page
        .locator('video')
        .evaluate((video: HTMLVideoElement) => video.currentTime),
    )
    .toBeCloseTo(108.3, 0);
  expect(errors).toEqual([]);
});

test('sources have type, preview, qualifications and original/versioned links', async ({
  page,
}) => {
  await page.goto('/#C026');
  await expect(page.locator('.finding-panel h2')).toHaveText(
    'A reported spousal winery interest',
  );
  await expect(page.locator('.finding-scope')).toContainText(
    'separated from fraud',
  );
  await page.locator('.evidence-row').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const image = page.locator('.document-preview img');
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(100);
  await expect(
    page.getByRole('link', { name: 'Original Schedule A, winery entry' }),
  ).toHaveAttribute('href', /disclosures-clerk\.house\.gov.*\.pdf#page=1$/);
  await expect(
    page.getByRole('link', { name: 'Open full source' }),
  ).toHaveAttribute('href', /disclosures-clerk.house.gov/);
  await expect(
    page.getByRole('link', { name: /Versioned document copy/ }),
  ).toHaveAttribute(
    'href',
    /github.com\/KhademOHAli1\/claim-by-claim\/blob\/main\/evidence\/originals\/E015.pdf/,
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page
    .locator('.site-header')
    .getByRole('button', { name: 'Sources', exact: true })
    .click();
  await expect(page.locator('.result-count')).toHaveText(
    '40 of 40 source records',
  );
  await page.getByLabel('Search evidence').fill('S010');
  await expect(page.locator('.registry-row')).toHaveCount(1);
  await page.locator('.registry-row').click();
  await expect(page.locator('.metadata-preview')).toContainText(
    'not a reproduction of the full page',
  );
  await expect(page.locator('.source-explainer')).toContainText('donor');
  await expect(page.locator('.document-preview')).toHaveCount(0);

  for (const [id, label, hash] of [
    [
      'S003',
      'Refugee and arrival account',
      '#:~:text=four%20years%20in%20a%20refugee%20camp',
    ],
    ['S034', 'Subd. 1 · examination requirements', '#stat.171.13.1'],
    [
      'S020',
      'Reported settlement · syndicated copy',
      '#:~:text=reached%20a%20settlement%20with%20Mynett%20and%20Hailer',
    ],
  ] as const) {
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Sources', exact: true }).click();
    await page.getByLabel('Search evidence').fill(id);
    await page.locator('.registry-row').click();
    const link = page.getByRole('link', { name: label, exact: true });
    const href = await link.getAttribute('href');
    expect(new URL(href!).hash).toBe(hash);
  }
});

test('deep links, honest verdict definitions and correction links remain available', async ({
  page,
}) => {
  await page.goto('/#C017');
  await expect(page.locator('.finding-panel h2')).toHaveText(
    'An inquiry is documented',
  );
  await expect(page.locator('.finding-summary')).toContainText(
    'live procedural status',
  );
  await page
    .locator('.site-header')
    .getByRole('button', { name: 'Method', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText(
    'This does not establish a deliberate lie',
  );
  await expect(page.getByRole('dialog')).toContainText(
    'This does not mean it is false',
  );
  await page.keyboard.press('Escape');
  await page
    .getByRole('region', { name: 'Selected claim fact check' })
    .getByRole('button', { name: 'Did we make a mistake?' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Did we make a mistake?' });
  await expect(dialog).toContainText('C017');
  await expect(dialog).toContainText('Describe what should change');
  const form = new URL(
    (await dialog
      .getByRole('link', { name: 'Open an issue' })
      .getAttribute('href'))!,
  );
  expect(form.searchParams.get('template')).toBe('correction.yml');
  expect(form.searchParams.get('claim')).toBe('C017');
  expect(form.searchParams.get('timestamp')).toBe('00:56');
  await expect(
    dialog.getByRole('link', { name: 'Start a pull request' }),
  ).toHaveAttribute(
    'href',
    'https://github.com/KhademOHAli1/claim-by-claim/compare',
  );
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-slot="tabs-list"]')).toBeVisible();
  await expect(page.locator('[data-slot="button"]').first()).toBeVisible();
});

test('panes resize and dock without recreating the video, and layout survives reload', async ({
  page,
}) => {
  await page.goto('/');
  const videoPane = page.locator('.video-panel');
  await expect(videoPane).toBeVisible();
  const initial = (await videoPane.boundingBox())!;
  const divider = (await page
    .locator('[role=separator][aria-orientation=vertical]')
    .first()
    .boundingBox())!;
  const dividerX = divider.x + divider.width / 2;
  const dividerY = divider.y + divider.height / 2;
  await page.mouse.move(dividerX, dividerY);
  await page.mouse.down();
  await page.mouse.move(dividerX + 80, dividerY, { steps: 10 });
  await page.mouse.up();
  await expect
    .poll(async () => (await videoPane.boundingBox())!.width)
    .toBeGreaterThan(initial.width + 60);

  const video = (await page.locator('video').elementHandle())!;
  await video.evaluate((element: HTMLVideoElement) => {
    element.currentTime = 27;
  });
  const tab = (await page
    .locator('.flexlayout__tab_button')
    .filter({ hasText: /^Video$/ })
    .boundingBox())!;
  const transcript = (await page.locator('.transcript-panel').boundingBox())!;
  await page.mouse.move(tab.x + 20, tab.y + 10);
  await page.mouse.down();
  await page.mouse.move(
    transcript.x + transcript.width - 12,
    transcript.y + transcript.height / 2,
    { steps: 25 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await videoPane.boundingBox())!.x)
    .toBeGreaterThan(200);
  expect(
    await video.evaluate((element: HTMLVideoElement) => ({
      connected: element.isConnected,
      time: element.currentTime,
    })),
  ).toEqual({ connected: true, time: 27 });

  await page.reload();
  await expect
    .poll(async () => (await videoPane.boundingBox())?.x ?? 0)
    .toBeGreaterThan(200);
  await expect(
    page.locator('.site-header').getByRole('button', { name: 'Reset layout' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Method', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Reset layout' })
    .click();
  await expect
    .poll(async () => (await videoPane.boundingBox())?.x ?? 0)
    .toBeCloseTo(initial.x);
});

test('signal bars encode assessment confidence and support without changing the verdict label', async ({
  page,
}) => {
  for (const [id, verdict, tone, level] of [
    ['C030', 'Supported', 'green', 3],
    ['C029', 'Supported', 'green', 2],
    ['C005', 'Unsubstantiated', 'red', 3],
    ['C013', 'Contradicted', 'red', 3],
  ] as const) {
    await page.goto(`/#${id}`);
    await expect(page.locator('.finding-meta .verdict-badge')).toHaveText(
      verdict,
    );
    await expect(
      page.locator(`.confidence-signal.signal-${tone} [data-filled=true]`),
    ).toHaveCount(level);
  }
});
