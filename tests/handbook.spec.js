// @ts-check
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const KEY = 'AIzaFakeKeyForTests000000000000000000000';
const GEMINI = 'https://generativelanguage.googleapis.com/**';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-goog-api-key',
};
const SKILL_PATH = path.join(__dirname, '..', 'skills', 'handbook', 'SKILL.md');
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const pdf = (name = 'lecture-3.pdf') => ({ name, mimeType: 'application/pdf', buffer: PDF_BYTES });

const sse = (...chunks) => chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join('');
const text = (value, finishReason) => ({
  candidates: [{ content: { role: 'model', parts: [{ text: value }] }, ...(finishReason ? { finishReason } : {}) }],
});
const thought = (value) => ({ candidates: [{ content: { role: 'model', parts: [{ text: value, thought: true }] } }] });
const apiError = (code, status, message, details = []) => ({ error: { code, status, message, details } });

/** Answers Gemini calls with respond(callNumber) and records every request. */
async function mockGemini(page, respond) {
  const calls = [];
  await page.route(GEMINI, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    calls.push({ url: request.url(), headers: await request.allHeaders(), body: request.postDataJSON() });
    const { status = 200, json, body } = respond(calls.length);
    return route.fulfill({
      status,
      headers: { ...CORS, 'content-type': json ? 'application/json' : 'text/event-stream' },
      body: json ? JSON.stringify(json) : body,
    });
  });
  return calls;
}

async function saveKey(page) {
  await page.goto('/');
  await page.getByLabel('Paste your key here').fill(KEY);
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByText('Choose a PDF', { exact: true })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  // Headless WebKit has no print dialog, so stand in for it and fire the events Safari fires.
  await page.addInitScript(() => {
    window.__printCalls = 0;
    window.print = () => {
      window.__printCalls += 1;
      window.dispatchEvent(new Event('beforeprint'));
      window.dispatchEvent(new Event('afterprint'));
    };
  });
});

test('first visit asks for a key and keeps it only in this browser', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Turn class notes into a handbook you can revise from' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Google AI Studio' })).toHaveAttribute('href', 'https://aistudio.google.com/apikey');
  await expect(page.getByText('Your key stays on this phone.')).toBeVisible();
  await expect(page.getByText('Choose a PDF', { exact: true })).toBeHidden();

  await page.getByLabel('Paste your key here').fill(`  ${KEY}  `);
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByText('Choose a PDF', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('handbook.geminiKey'))).toBe(KEY);

  await page.reload();
  await expect(page.getByText('Choose a PDF', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Change key' }).click();
  await page.getByRole('button', { name: 'Remove my key from this phone' }).click();
  expect(await page.evaluate(() => localStorage.getItem('handbook.geminiKey'))).toBeNull();
  await expect(page.getByLabel('Paste your key here')).toBeVisible();
});

test('makes a handbook from a PDF, using the skill as the instructions', async ({ page }) => {
  const calls = await mockGemini(page, () => ({
    body: sse(
      thought('**Planning the handbook** from the lecture'),
      text('# Cell biology\n\n## Organelles\n\n- **Mitochondria**: release energy from glucose.\n- `ATP → ADP + Pi`\n  - Pi means inorganic phosphate\n\n'),
      text('| Organelle | Job |\n| --- | :---: |\n| Ribosome | Makes proteins |\n\n> **Must remember**\n> - Mitochondria release energy\n\n## One-page revision sheet\n\n1. Mitochondria: energy\n2. Ribosomes: proteins\n', 'STOP'),
    ),
  }));
  await saveKey(page);
  await page.setInputFiles('#file-input', pdf());

  const handbook = page.locator('#handbook');
  await expect(handbook.locator('h1')).toHaveText('Cell biology');
  await expect(page.getByRole('button', { name: 'Save as PDF' })).toBeVisible();
  await expect(handbook.locator('strong').first()).toHaveText('Mitochondria');
  await expect(handbook.locator('code')).toHaveText('ATP → ADP + Pi');
  await expect(handbook.locator('ul ul > li')).toHaveText('Pi means inorganic phosphate');
  await expect(handbook.locator('td').first()).toHaveText('Ribosome');
  await expect(handbook.locator('th.al-center')).toHaveText('Job');
  await expect(handbook.locator('blockquote')).toContainText('Must remember');
  await expect(handbook.locator('h2.new-page')).toHaveText('One-page revision sheet');
  await expect(handbook.locator('ol > li')).toHaveCount(2);
  await expect(handbook).not.toContainText('Planning the handbook');
  await expect(page).toHaveTitle('Handbook - lecture-3');

  expect(calls).toHaveLength(1);
  const [call] = calls;
  expect(call.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
  expect(call.headers['x-goog-api-key']).toBe(KEY);
  const skill = fs.readFileSync(SKILL_PATH, 'utf8');
  expect(call.body.systemInstruction.parts[0].text).toBe(skill.replace(/^---\n[\s\S]*?\n---\n/, '').trim());
  const [pdfPart, promptPart] = call.body.contents[0].parts;
  expect(pdfPart.inlineData).toEqual({ mimeType: 'application/pdf', data: PDF_BYTES.toString('base64') });
  expect(promptPart.text).toContain('lecture-3.pdf');

  // Reopening the app shows the last handbook again.
  await page.reload();
  await expect(page.locator('#handbook h1')).toHaveText('Cell biology');
});

test('model output cannot run script, load anything or link to javascript:', async ({ page }) => {
  const evil = [
    '# Notes <script>window.__pwned = "heading"</script>',
    '',
    '<script>window.__pwned = "script"</script>',
    '<img src="https://evil.example/x.png" onerror="window.__pwned = \'img\'">',
    '<iframe src="javascript:window.__pwned=\'iframe\'"></iframe>',
    '<svg onload="window.__pwned=\'svg\'"><circle r="5"></circle></svg>',
    '<style>body { display: none }</style>',
    '',
    '- **Bold <img src=x onerror="window.__pwned=\'bold\'">** term',
    '- [click me](javascript:window.__pwned=\'link\')',
    '- [real source](https://example.com/notes)',
    '- ![tracker](https://evil.example/pixel.png)',
    '- <a href="javascript:window.__pwned=\'anchor\'">anchor</a>',
    '',
    '| Term | Meaning |',
    '| --- | --- |',
    '| <b onmouseover="window.__pwned=\'cell\'">x</b> | `<script>alert(1)</script>` |',
    '',
    '> <object data="javascript:window.__pwned=\'object\'"></object>',
  ].join('\n');
  const requested = [];
  page.on('request', (request) => requested.push(request.url()));
  await mockGemini(page, () => ({ body: sse(text(evil, 'STOP')) }));
  await saveKey(page);
  await page.setInputFiles('#file-input', pdf());

  const handbook = page.locator('#handbook');
  await expect(handbook.locator('h1')).toHaveText('Notes <script>window.__pwned = "heading"</script>');
  await expect(handbook).toContainText('<iframe src="javascript:');
  await expect(handbook.locator('script, img, iframe, svg, style, object, embed, link, meta, form, input')).toHaveCount(0);

  const attributes = await handbook.evaluate((root) => [...root.querySelectorAll('*')]
    .flatMap((el) => [...el.attributes].map((attr) => `${el.tagName}.${attr.name}=${attr.value}`)));
  expect(attributes.filter((attr) => /\.on|javascript:/i.test(attr))).toEqual([]);
  expect(await handbook.locator('a').evaluateAll((links) => links.map((a) => a.getAttribute('href')))).toEqual(['https://example.com/notes']);

  await handbook.getByText('click me').click();
  await handbook.locator('td').first().hover();
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(requested.filter((url) => url.includes('evil.example'))).toEqual([]);
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', /script-src 'self'/);
});

test('explains common problems in plain words', async ({ page }) => {
  let reply = {};
  await mockGemini(page, () => reply);
  await saveKey(page);
  const problem = page.locator('#problem');

  reply = { status: 400, json: apiError(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }]) };
  await page.setInputFiles('#file-input', pdf());
  await expect(problem).toContainText("Google didn't accept your API key");
  await expect(page.getByRole('button', { name: 'Change key' })).toBeVisible();

  reply = { status: 429, json: apiError(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota.', [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }]) };
  await page.setInputFiles('#file-input', pdf());
  await expect(problem).toContainText("You've used up today's free Gemini requests");
  await expect(problem).toContainText('midnight in California');

  reply = { status: 429, json: apiError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded.', [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' }]) };
  await page.setInputFiles('#file-input', pdf());
  await expect(problem).toContainText('Wait 37 seconds');

  reply = { status: 503, json: apiError(503, 'UNAVAILABLE', 'The model is overloaded.') };
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(problem).toContainText('Gemini is busy');

  reply = { body: sse(text('NO_CONTENT_FOUND: the pages are blank', 'STOP')) };
  await page.setInputFiles('#file-input', pdf('blank.pdf'));
  await expect(problem).toContainText('Gemini found no study content in blank.pdf (the pages are blank)');
  await expect(page.locator('#result')).toBeHidden();
});

test('checks the file before sending anything', async ({ page }, testInfo) => {
  const calls = await mockGemini(page, () => ({ body: sse(text('# Never used', 'STOP')) }));
  await saveKey(page);
  const problem = page.locator('#problem');

  await page.setInputFiles('#file-input', {
    name: 'slides.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    buffer: Buffer.from('PK'),
  });
  await expect(problem).toContainText("slides.pptx isn't a PDF");

  const big = testInfo.outputPath('big.pdf');
  fs.mkdirSync(path.dirname(big), { recursive: true });
  fs.writeFileSync(big, Buffer.alloc(50 * 1024 * 1024 + 1));
  await page.setInputFiles('#file-input', big);
  await expect(problem).toContainText('Gemini takes PDFs up to 50 MB');
  expect(calls).toHaveLength(0);
});

test('falls back to gemini-flash-latest if the pinned model is retired', async ({ page }) => {
  const calls = await mockGemini(page, (n) => (n === 1
    ? { status: 404, json: apiError(404, 'NOT_FOUND', 'models/gemini-3.8-flash is not found for API version v1beta.') }
    : { body: sse(text('# Fallback works', 'STOP')) }));
  await saveKey(page);
  await page.setInputFiles('#file-input', pdf());
  await expect(page.locator('#handbook h1')).toHaveText('Fallback works');
  expect(calls.map((call) => call.url.split('/models/')[1])).toEqual([
    'gemini-3.8-flash:streamGenerateContent?alt=sse',
    'gemini-flash-latest:streamGenerateContent?alt=sse',
  ]);
});

test('says so when a handbook was cut short', async ({ page }) => {
  await mockGemini(page, () => ({ body: sse(text('# Part one\n\n- point', 'MAX_TOKENS')) }));
  await saveKey(page);
  await page.setInputFiles('#file-input', pdf());
  await expect(page.locator('#result-note')).toContainText('stops early because the notes are very long');
  await expect(page.locator('#handbook h1')).toHaveText('Part one');
});

test('Save as PDF prints only the handbook', async ({ page }) => {
  await mockGemini(page, () => ({ body: sse(text('# Physics\n\n- **Force**: push or pull\n\n## One-page revision sheet\n\n- `F = m × a`', 'STOP')) }));
  await saveKey(page);
  await page.setInputFiles('#file-input', pdf('physics.pdf'));
  await page.getByRole('button', { name: 'Save as PDF' }).click();
  expect(await page.evaluate(() => window.__printCalls)).toBe(1);
  await expect(page).toHaveTitle('Handbook - physics');
  await page.waitForTimeout(3000);
  await expect(page.locator('#print-hint')).toBeHidden();

  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#handbook')).toBeVisible();
  for (const selector of ['.masthead', '#pick', '#actions', '.privacy']) {
    await expect(page.locator(selector)).toBeHidden();
  }
  const pageBreak = await page.locator('h2.new-page').evaluate((el) => {
    const style = getComputedStyle(el);
    return `${style.breakBefore} ${style.pageBreakBefore}`;
  });
  expect(pageBreak).toMatch(/page|always/);
});

test('explains what to do when the print screen cannot open (Home Screen web app)', async ({ page }) => {
  await page.addInitScript(() => {
    window.print = () => {};
  });
  await mockGemini(page, () => ({ body: sse(text('# Notes\n\n- point', 'STOP')) }));
  await saveKey(page);
  await page.setInputFiles('#file-input', pdf());
  await page.getByRole('button', { name: 'Save as PDF' }).click();
  await expect(page.locator('#print-hint')).toBeVisible({ timeout: 5000 });
});

test('the skill file is a valid Agent Skill', () => {
  const skill = fs.readFileSync(SKILL_PATH, 'utf8');
  const front = skill.match(/^---\n([\s\S]*?)\n---\n/);
  expect(front).not.toBeNull();
  const header = front ? front[1] : '';
  expect(header).toMatch(/^name: handbook$/m);
  const description = (header.match(/^description: (.+)$/m) || [])[1] || '';
  expect(description.length).toBeGreaterThan(20);
  expect(description.length).toBeLessThanOrEqual(1024);
});
