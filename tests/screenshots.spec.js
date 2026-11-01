// @ts-check
// Saves iPhone 12 (WebKit) screenshots of every screen for review. CI uploads them as the
// "screenshots" artifact. All content is mocked.
const { test, expect } = require('@playwright/test');
const path = require('path');
const {
  EXPLAIN_MD, HANDBOOK_MD, dayLimit, isGenerate, minuteLimit, mockGemini, pdf, png, pptx, respirationDeck, saveKey, stubPrint, answer,
} = require('./fixtures');

const OUT = path.join(__dirname, 'screenshots');

async function shoot(page, name, fullPage = false) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage, animations: 'disabled' });
}

// Wait until the app has brought the new result into view by itself (no test scrolling).
async function landed(page) {
  await expect(page.locator('#handbook h1')).toBeVisible();
  await expect.poll(() => page.locator('#result').evaluate((el) => Math.round(el.getBoundingClientRect().top)), { timeout: 5000 }).toBeLessThanOrEqual(20);
  await page.waitForTimeout(300);
}

test.beforeEach(async ({ page }) => stubPrint(page));

test('setup and pick screens', async ({ page }) => {
  await mockGemini(page, () => answer('# Never'));
  await page.goto('/');
  await expect(page.getByText('One-time setup')).toBeVisible();
  await shoot(page, '01-setup', true);
  await page.getByLabel('Paste your key here').fill('AIzaFakeKeyForScreenshots0000000000000');
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByText('Choose PDF or slides', { exact: true })).toBeVisible();
  await shoot(page, '02-pick');
  await page.getByRole('radio', { name: /Explain simply/ }).check();
  await shoot(page, '02b-pick-explain-selected');
});

test('working screen', async ({ page }) => {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = await mockGemini(page, async () => {
    await gate;
    return answer(HANDBOOK_MD);
  });
  await saveKey(page);
  await page.setInputFiles('#doc-input', pdf());
  await expect.poll(() => calls.filter(isGenerate).length).toBe(1);
  await page.waitForTimeout(1200);
  await shoot(page, '03-working');
  release();
  await expect(page.locator('#handbook h1')).toBeVisible();
});

test('handbook result, on screen and as printed', async ({ page }) => {
  await mockGemini(page, () => answer(HANDBOOK_MD));
  await saveKey(page);
  await page.setInputFiles('#doc-input', pdf('respiration-lecture.pdf'));
  await expect(page.locator('#handbook svg.diagram')).toHaveCount(3);
  await landed(page);
  await shoot(page, '04-handbook-top');
  await shoot(page, '04-handbook-full', true);
  await page.getByRole('button', { name: 'Share' }).click();
  await expect(page.locator('#actions #print-tip')).toBeInViewport();
  await shoot(page, '05-share-tip');
  await page.emulateMedia({ media: 'print' });
  await shoot(page, '06-handbook-print', true);
});

test('Explain simply result', async ({ page }) => {
  await mockGemini(page, () => answer(EXPLAIN_MD));
  await saveKey(page);
  await page.getByRole('radio', { name: /Explain simply/ }).check();
  await page.setInputFiles('#doc-input', pdf('breathing.pdf'));
  await expect(page.locator('#handbook h1')).toHaveText('Breathing, explained simply');
  await landed(page);
  await shoot(page, '07-explain-top');
  await shoot(page, '07-explain-full', true);
});

test('PowerPoint and photo flows', async ({ page }) => {
  let release = () => {};
  let gate = new Promise((resolve) => { release = resolve; });
  const calls = await mockGemini(page, async () => {
    await gate;
    return answer(HANDBOOK_MD);
  });
  await saveKey(page);
  const deck = await respirationDeck(page);
  await page.setInputFiles('#doc-input', pptx('Respiration_lecture.pptx', deck));
  await expect.poll(() => calls.filter(isGenerate).length).toBe(1);
  await shoot(page, '08-slides-working');
  release();
  await landed(page);
  await shoot(page, '09-slides-result');

  gate = new Promise((resolve) => { release = resolve; });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.setInputFiles('#photo-input', [
    { name: 'whiteboard.png', mimeType: 'image/png', buffer: png(1600, 1200) },
    { name: 'textbook-page.png', mimeType: 'image/png', buffer: png(1200, 1600) },
  ]);
  await expect.poll(() => calls.filter(isGenerate).length).toBe(2);
  await shoot(page, '10-photos-working');
  release();
  await landed(page);
  await shoot(page, '11-photos-result');
});

test('error screens', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => !window.__offline });
  });
  let reply = dayLimit();
  await mockGemini(page, () => reply);
  await saveKey(page);

  await page.setInputFiles('#doc-input', pdf());
  await expect(page.locator('#problem-code')).toHaveText('Code: LIMIT_DAY');
  await shoot(page, '12-error-limit-day');

  reply = minuteLimit(45);
  await page.setInputFiles('#doc-input', pdf());
  await expect(page.locator('#problem-code')).toHaveText('Code: LIMIT_MINUTE');
  await shoot(page, '13-error-limit-minute');

  await page.evaluate(() => { window.__offline = true; });
  await page.setInputFiles('#doc-input', pdf());
  await expect(page.locator('#problem-code')).toHaveText('Code: OFFLINE');
  await shoot(page, '14-error-offline');
  await page.evaluate(() => { window.__offline = false; });

  await page.setInputFiles('#doc-input', { name: 'lecture.key', mimeType: 'application/x-iwork-keynote-sffkey', buffer: Buffer.from('keynote') });
  await expect(page.locator('#problem-code')).toHaveText('Code: KEYNOTE');
  await shoot(page, '15-error-unsupported-file');
});
