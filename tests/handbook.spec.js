// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const {
  EXPLAIN_MD, HANDBOOK_MD, KEY, MODELS, PDF_BYTES, ROOT,
  answer, dayLimit, expectProblem, gone, isGenerate, minuteLimit, mockGemini, modelOf, noFreeQuota,
  pdf, saveKey, skillBody, sse, stubPrint, text, thought,
} = require('./fixtures');

test.beforeEach(async ({ page }) => stubPrint(page));

test('first visit asks for a free key and keeps it only in this browser', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Turn class notes into a handbook you can revise from' })).toBeVisible();
  await expect(page.getByText('Made with love for Zainab, the brightest mind I know')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Google AI Studio' })).toHaveAttribute('href', 'https://aistudio.google.com/apikey');
  await expect(page.getByText('no card or billing is needed', { exact: false })).toBeVisible();
  await expect(page.getByText('Your key stays on this phone.', { exact: false })).toBeVisible();
  await expect(page.getByText('Choose PDF or slides', { exact: true })).toBeHidden();

  await page.getByLabel('Paste your key here').fill(`  ${KEY}  `);
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByText('Choose PDF or slides', { exact: true })).toBeVisible();
  await expect(page.getByText('Made with love for Zainab, the brightest mind I know')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('handbook.geminiKey'))).toBe(KEY);

  await page.reload();
  await page.getByRole('button', { name: 'Change key' }).click();
  await page.getByRole('button', { name: 'Remove my key from this phone' }).click();
  expect(await page.evaluate(() => localStorage.getItem('handbook.geminiKey'))).toBeNull();
  await expect(page.getByLabel('Paste your key here')).toBeVisible();
});

test('the copy is kind, free-only and never names the brand it evokes', async ({ page }) => {
  await page.goto('/');
  const copy = await page.evaluate(() => document.documentElement.outerHTML);
  expect(copy).not.toMatch(/barbie/i);
  expect(copy).not.toMatch(/\bdumb\b|\bstupid\b/i);
  expect(copy).not.toMatch(/upgrade to|billing account|paid plan|paid tier/i);
  expect(copy).not.toContain('Copy text');
  const catalog = fs.readFileSync(path.join(ROOT, 'errors.js'), 'utf8');
  expect(catalog).not.toMatch(/\bdumb\b|\bstupid\b|sorry|oops|upgrade|billing|paid/i);
});

test('makes a handbook from a PDF, using the handbook skill', async ({ page }) => {
  const calls = await mockGemini(page, () => ({
    body: sse(thought('**Planning the handbook** from the lecture'), text(HANDBOOK_MD.slice(0, 400)), text(HANDBOOK_MD.slice(400), 'STOP')),
  }));
  await saveKey(page);
  await page.setInputFiles('#doc-input', pdf());

  const handbook = page.locator('#handbook');
  await expect(handbook.locator('h1')).toHaveText('Respiration physiology');
  await expect(page.getByRole('button', { name: 'Save as PDF' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share' })).toBeVisible();
  await expect(handbook.locator('strong').first()).toHaveText('Conducting zone');
  await expect(handbook.locator('th').nth(1)).toHaveText('Inspiration');
  await expect(handbook.locator('blockquote').first()).toContainText('Must remember');
  await expect(handbook.locator('h2.new-page')).toHaveText('One-page revision sheet');
  await expect(handbook.locator('svg.diagram')).toHaveCount(3);
  await expect(handbook).not.toContainText('Planning the handbook');
  await expect(page.locator('#result-note')).toBeHidden();
  await expect(page).toHaveTitle('Handbook - respiration-lecture');

  const generate = calls.filter(isGenerate);
  expect(generate).toHaveLength(1);
  expect(modelOf(generate[0])).toBe('gemini-3.8-flash');
  expect(generate[0].url).toContain(':streamGenerateContent?alt=sse');
  expect(generate[0].headers['x-goog-api-key']).toBe(KEY);
  expect(generate[0].body.systemInstruction.parts[0].text).toBe(skillBody('handbook'));
  const [pdfPart, promptPart] = generate[0].body.contents[0].parts;
  expect(pdfPart.inlineData).toEqual({ mimeType: 'application/pdf', data: PDF_BYTES.toString('base64') });
  expect(promptPart.text).toBe('Make my study handbook from this PDF (respiration-lecture.pdf).');

  await page.reload();
  await expect(page.locator('#handbook h1')).toHaveText('Respiration physiology');
});

test('Explain simply uses the explain skill and is remembered', async ({ page }) => {
  const calls = await mockGemini(page, () => answer(EXPLAIN_MD));
  await saveKey(page);
  await page.getByRole('radio', { name: /Explain simply/ }).check();
  await page.setInputFiles('#doc-input', pdf('breathing.pdf'));
  await expect(page.locator('#handbook h1')).toHaveText('Breathing, explained simply');
  await expect(page.locator('#handbook blockquote')).toContainText('Check yourself');
  await expect(page).toHaveTitle('Explained - breathing');

  const [call] = calls.filter(isGenerate);
  expect(call.body.systemInstruction.parts[0].text).toBe(skillBody('explain'));
  expect(call.body.contents[0].parts.at(-1).text).toBe('Explain this PDF (breathing.pdf) simply, so I can understand it.');

  await page.reload();
  await expect(page.locator('input[name="mode"][value="explain"]')).toBeChecked();
});

test('diagrams are drawn as SVG, fall back to text, and keep hostile labels inert', async ({ page }) => {
  const md = [
    '# Diagrams',
    '```diagram',
    'type: flow',
    'title: <img src=x onerror="alert(1)">',
    '- Nose <script>window.hacked=2</script>',
    '- <svg onload="alert(3)">Pharynx</svg>',
    '- Larynx',
    '```',
    '```diagram',
    'type: tree',
    '- Respiratory system',
    '  - Upper tract',
    '    - Nose',
    '  - Lower tract',
    '    - Trachea',
    '```',
    '```diagram',
    'type: spiral',
    '- not a diagram we draw',
    '- so it shows as text',
    '```',
  ].join('\n');
  await mockGemini(page, () => answer(md));
  await saveKey(page);
  await page.setInputFiles('#doc-input', pdf());

  const handbook = page.locator('#handbook');
  await expect(handbook.locator('svg.diagram')).toHaveCount(2);
  const flow = handbook.locator('svg.diagram-flow');
  await expect(flow.locator('title')).toHaveText('<img src=x onerror="alert(1)">');
  await expect(flow).toContainText('Nose <script>window.hacked=2</script>');
  await expect(flow).toContainText('<svg onload="alert(3)">Pharynx</svg>');
  await expect(flow.locator('rect.dg-box')).toHaveCount(3);
  await expect(handbook.locator('svg.diagram-tree rect.dg-box')).toHaveCount(5);
  await expect(handbook.locator('pre code')).toContainText('type: spiral');
  await expect(handbook.locator('script, img, iframe, foreignObject, image, a')).toHaveCount(0);
  await expect(handbook.locator('svg svg')).toHaveCount(0);
  const attributes = await handbook.evaluate((root) => [...root.querySelectorAll('*')]
    .flatMap((el) => [...el.attributes].map((attr) => `${el.tagName}.${attr.name}=${attr.value}`)));
  expect(attributes.filter((attr) => /\.on|javascript:|href/i.test(attr))).toEqual([]);
  expect(await page.evaluate(() => window.hacked)).toBeUndefined();
});

test('model output cannot run script, load anything or link to javascript:', async ({ page }) => {
  const evil = [
    '# Notes <script>window.__pwned = "heading"</script>',
    '',
    '<script>window.__pwned = "script"</script>',
    '<img src="https://evil.example/x.png" onerror="window.__pwned = \'img\'">',
    '<iframe src="javascript:window.__pwned=\'iframe\'"></iframe>',
    '<style>body { display: none }</style>',
    '',
    '- **Alveoli <img src=x onerror="window.__pwned=\'bold\'">** term',
    '- [click me](javascript:window.__pwned=\'link\')',
    '- [real source](https://example.com/notes)',
    '- ![tracker](https://evil.example/pixel.png)',
    '',
    '| Term | Meaning |',
    '| --- | --- |',
    '| <b onmouseover="window.__pwned=\'cell\'">x</b> | `<script>alert(1)</script>` |',
  ].join('\n');
  const requested = [];
  page.on('request', (request) => requested.push(request.url()));
  await mockGemini(page, () => answer(evil));
  await saveKey(page);
  await page.setInputFiles('#doc-input', pdf());

  const handbook = page.locator('#handbook');
  await expect(handbook.locator('h1')).toHaveText('Notes <script>window.__pwned = "heading"</script>');
  await expect(handbook).toContainText('<iframe src="javascript:');
  await expect(handbook.locator('script, img, iframe, style, object, embed, link, meta, form, input')).toHaveCount(0);
  const attributes = await handbook.evaluate((root) => [...root.querySelectorAll('*')]
    .flatMap((el) => [...el.attributes].map((attr) => `${el.tagName}.${attr.name}=${attr.value}`)));
  expect(attributes.filter((attr) => /\.on|javascript:/i.test(attr))).toEqual([]);
  expect(await handbook.locator('a').evaluateAll((links) => links.map((a) => a.getAttribute('href')))).toEqual(['https://example.com/notes']);
  await handbook.getByText('click me').click();
  await handbook.locator('td').first().hover();
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(requested.filter((url) => url.includes('evil.example'))).toEqual([]);
  const allowedHosts = ['127.0.0.1', 'generativelanguage.googleapis.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
  expect(requested.filter((url) => /^https?:/.test(url) && !allowedHosts.includes(new URL(url).hostname))).toEqual([]);
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain('font-src https://fonts.gstatic.com');
  expect(csp).toContain("connect-src 'self' https://generativelanguage.googleapis.com");
});

test('Save as PDF and Share open the print screen with the right tip, and print only the handbook', async ({ page }) => {
  await mockGemini(page, () => answer(HANDBOOK_MD));
  await saveKey(page);
  await page.setInputFiles('#doc-input', pdf('respiration.pdf'));

  await page.getByRole('button', { name: 'Save as PDF' }).click();
  expect(await page.evaluate(() => window.__printCalls)).toBe(1);
  await expect(page.locator('#print-tip')).toHaveText('On the print screen, tap the Share icon at the top, then Save to Files.');
  await page.getByRole('button', { name: 'Share' }).click();
  expect(await page.evaluate(() => window.__printCalls)).toBe(2);
  await expect(page.locator('#print-tip')).toHaveText('On the print screen, tap the Share icon at the top, then pick WhatsApp, Mail, AirDrop or another app.');
  await expect(page).toHaveTitle('Handbook - respiration');
  await page.waitForTimeout(3000);
  await expect(page.locator('#notice')).toBeHidden();
  await expect(page.locator('#print-tip')).toBeVisible();

  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#handbook')).toBeVisible();
  await expect(page.locator('#handbook svg.diagram').first()).toBeVisible();
  for (const selector of ['.masthead', '#pick', '#actions', '#print-tip', '.privacy']) await expect(page.locator(selector)).toBeHidden();
  const style = await page.locator('h2.new-page').evaluate((el) => {
    const s = getComputedStyle(el);
    return `${s.breakBefore} ${s.pageBreakBefore}`;
  });
  expect(style).toMatch(/page|always/);
  const highlight = await page.locator('#handbook strong').first().evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(highlight).toContain('gradient');
});

test('when the print screen cannot open (Home Screen web app), both buttons say to use Safari', async ({ page }) => {
  await page.addInitScript(() => {
    window.print = () => {};
  });
  await mockGemini(page, () => answer('# Notes\n\n- **Alveoli**: air sacs'));
  await saveKey(page);
  await page.setInputFiles('#doc-input', pdf());
  for (const name of ['Save as PDF', 'Share']) {
    await page.getByRole('button', { name }).click();
    await expect(page.locator('#notice')).toContainText("The print screen didn't open");
    await expect(page.locator('#notice')).toContainText('Open this site in Safari');
    await expect(page.locator('#notice .code')).toHaveText('Code: PRINT_UNAVAILABLE');
    await expect(page.locator('#print-tip')).toBeHidden();
  }
});

test.describe('free models', () => {
  test('a used-up daily limit moves on to the next free model and says so', async ({ page }) => {
    const calls = await mockGemini(page, (call) => (modelOf(call) === 'gemini-3.8-flash' ? dayLimit() : answer('# Lungs\n\n- **Alveoli**: air sacs')));
    await saveKey(page);
    await page.setInputFiles('#doc-input', pdf());
    await expect(page.locator('#handbook h1')).toHaveText('Lungs');
    await expect(page.locator('#result-note')).toHaveText("Made with Google's backup model because today's main free limit is used up.");
    expect(calls.filter(isGenerate).map(modelOf)).toEqual(['gemini-3.8-flash', 'gemini-3.6-flash']);
  });

  test('a per-minute limit does not move on: it counts down, then Try again works', async ({ page }) => {
    let first = true;
    const calls = await mockGemini(page, () => {
      if (first) {
        first = false;
        return minuteLimit(2);
      }
      return answer('# Lungs\n\n- **Alveoli**: air sacs');
    });
    await saveKey(page);
    await page.setInputFiles('#doc-input', pdf());
    await expectProblem(page, 'LIMIT_MINUTE', 'Too many requests this minute');
    const retry = page.locator('#retry');
    await expect(retry).toBeDisabled();
    await expect(retry).toHaveText(/Try again in \d s/);
    await expect(retry).toBeEnabled({ timeout: 5000 });
    await expect(retry).toHaveText('Try again');
    expect(calls.filter(isGenerate).map(modelOf)).toEqual(['gemini-3.8-flash']);
    await retry.click();
    await expect(page.locator('#handbook h1')).toHaveText('Lungs');
    await expect(page.locator('#result-note')).toBeHidden();
    expect(calls.filter(isGenerate).map(modelOf)).toEqual(['gemini-3.8-flash', 'gemini-3.8-flash']);
  });

  test("when every model's daily limit is used up, it says when they reset", async ({ page }) => {
    const calls = await mockGemini(page, () => dayLimit());
    await saveKey(page);
    await page.setInputFiles('#doc-input', pdf());
    await expectProblem(page, 'LIMIT_DAY', "You've used today's free handbooks");
    await expect(page.locator('#problem-body')).toContainText(/reset at \d{1,2}:\d{2}/);
    await expect(page.locator('#problem-body')).toContainText('(your time)');
    await expect(page.locator('#retry')).toBeHidden();
    expect(calls.filter(isGenerate).map(modelOf)).toEqual(MODELS);
  });

  test('a key with no free allowance on any model is explained', async ({ page }) => {
    const calls = await mockGemini(page, () => noFreeQuota());
    await saveKey(page);
    await page.setInputFiles('#doc-input', pdf());
    await expectProblem(page, 'NO_FREE_QUOTA', 'no free Gemini allowance');
    await expect(page.locator('#fix-key')).toBeVisible();
    expect(calls.filter(isGenerate).map(modelOf)).toEqual(MODELS);
  });

  test('gemini-flash-latest is only a last resort when every model is retired', async ({ page }) => {
    const calls = await mockGemini(page, (call) => (modelOf(call) === 'gemini-flash-latest' ? answer('# Lungs') : gone(modelOf(call))));
    await saveKey(page);
    await page.setInputFiles('#doc-input', pdf());
    await expect(page.locator('#handbook h1')).toHaveText('Lungs');
    await expect(page.locator('#result-note')).toHaveText("Made with Google's backup model because the main one isn't available any more.");
    expect(calls.filter(isGenerate).map(modelOf)).toEqual([...MODELS, 'gemini-flash-latest']);
  });

  test('if every model is gone, it tells the owner to update them', async ({ page }) => {
    await mockGemini(page, (call) => gone(modelOf(call)));
    await saveKey(page);
    await page.setInputFiles('#doc-input', pdf());
    await expectProblem(page, 'MODEL_GONE', 'have changed');
  });

  test('a daily limit is not retried on other models once text has started', async ({ page }) => {
    const calls = await mockGemini(page, () => ({
      body: `${sse(text('# Lungs\n\n- **Alveoli**: air sacs'))}data: ${JSON.stringify(dayLimit().json)}\r\n\r\n`,
    }));
    await saveKey(page);
    await page.setInputFiles('#doc-input', pdf());
    await expectProblem(page, 'LIMIT_DAY');
    await expect(page.locator('#handbook h1')).toHaveText('Lungs');
    await expect(page.locator('#result-note')).toContainText('This handbook is incomplete');
    expect(calls.filter(isGenerate).map(modelOf)).toEqual(['gemini-3.8-flash']);
  });
});

test('both skill files are valid Agent Skills', () => {
  for (const name of ['handbook', 'explain']) {
    const skill = fs.readFileSync(path.join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
    const front = skill.match(/^---\n([\s\S]*?)\n---\n/);
    expect(front).not.toBeNull();
    const header = front ? front[1] : '';
    expect(header).toMatch(new RegExp(`^name: ${name}$`, 'm'));
    const description = (header.match(/^description: (.+)$/m) || [])[1] || '';
    expect(description.length).toBeGreaterThan(20);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(skill).toContain('```diagram');
    expect(skill).toContain('NO_CONTENT_FOUND');
  }
});
