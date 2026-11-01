// @ts-check
// One test per entry in the error catalog (errors.js) that can be reproduced with mocks.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const {
  answer, apiError, buildPptx, expectProblem, isGenerate, minuteLimit, mockGemini, pdf, png, pptx, saveKey, sse, stubPrint, text,
} = require('./fixtures');

test.beforeEach(async ({ page }) => stubPrint(page));

const info = (reason) => [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }];

const API_CASES = [
  ['KEY_INVALID', 400, apiError(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', info('API_KEY_INVALID')), "Google didn't accept your key"],
  ['KEY_BLOCKED', 403, apiError(403, 'PERMISSION_DENIED', 'Requests from this referer are blocked.', info('API_KEY_HTTP_REFERRER_BLOCKED')), "Google won't let this key be used"],
  ['REGION', 400, apiError(400, 'FAILED_PRECONDITION', 'User location is not supported for the API use.'), "isn't available here"],
  ['BUSY', 503, apiError(503, 'UNAVAILABLE', 'The model is overloaded. Please try again later.'), 'Gemini is busy right now'],
  ['TIMEOUT', 504, apiError(504, 'DEADLINE_EXCEEDED', 'Deadline expired before operation could complete.'), 'Gemini took too long'],
  ['TOO_MUCH_AT_ONCE', 413, apiError(413, 'INVALID_ARGUMENT', 'Request payload size exceeds the limit.'), 'too much to send at once'],
  ['TOO_MANY_PAGES', 400, apiError(400, 'INVALID_ARGUMENT', 'The document has more than 1000 pages.'), 'too many pages'],
  ['PASSWORD', 400, apiError(400, 'INVALID_ARGUMENT', 'The document is password protected.'), 'locked with a password'],
  ['PROCESSING_FAILED', 400, apiError(400, 'INVALID_ARGUMENT', 'Unable to process input image.'), "Google couldn't read this file"],
  ['UNKNOWN (HTTP 418)', 418, apiError(418, 'TEAPOT', 'Unexpected.'), 'Something unexpected went wrong'],
];

for (const [code, status, json, title] of API_CASES) {
  test(`Google error ${code} is explained in plain words`, async ({ page }) => {
    await mockGemini(page, () => ({ status, json }));
    await saveKey(page);
    await page.setInputFiles('#doc-input', pdf());
    await expectProblem(page, code, title);
    const body = await page.locator('#problem').innerText();
    expect(body).not.toMatch(/INVALID_ARGUMENT|PERMISSION_DENIED|UNAVAILABLE|HTTP \d{3}(?!\))|\{|"error"/);
  });
}

test('a bad key offers Change key', async ({ page }) => {
  await mockGemini(page, () => ({ status: 400, json: API_CASES[0][2] }));
  await saveKey(page);
  await page.setInputFiles('#doc-input', pdf());
  await expectProblem(page, 'KEY_INVALID');
  await expect(page.locator('#retry')).toBeHidden();
  await page.locator('#fix-key').click();
  await expect(page.getByLabel('Paste your key here')).toBeVisible();
});

test('LIMIT_SIZE_MINUTE: a big file over the per-minute token allowance counts down', async ({ page }) => {
  await mockGemini(page, () => minuteLimit(1, 'GenerateContentInputTokensPerModelPerMinute-FreeTier'));
  await saveKey(page);
  await page.setInputFiles('#doc-input', pdf());
  await expectProblem(page, 'LIMIT_SIZE_MINUTE', 'a lot to read in one minute');
  await expect(page.locator('#retry')).toBeEnabled({ timeout: 4000 });
});

test('OFFLINE: no connection before starting', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => !window.__offline });
  });
  await mockGemini(page, () => answer('# Never'));
  await saveKey(page);
  await page.evaluate(() => { window.__offline = true; });
  await page.setInputFiles('#doc-input', pdf());
  await expectProblem(page, 'OFFLINE', "You're offline");
  await expect(page.locator('#retry')).toBeVisible();
});

test('NETWORK: Google could not be reached', async ({ page }) => {
  await mockGemini(page, (call) => (isGenerate(call) ? { abort: 'failed' } : { json: {} }));
  await saveKey(page);
  await page.setInputFiles('#doc-input', pdf());
  await expectProblem(page, 'NETWORK', "Couldn't reach Google");
});

test('CONNECTION_LOST: a dropped connection keeps the partial text, which can still be saved', async ({ page }) => {
  await page.addInitScript(() => {
    const read = ReadableStreamDefaultReader.prototype.read;
    ReadableStreamDefaultReader.prototype.read = async function readThenDrop() {
      if (this.__gotChunk) throw new TypeError('Load failed');
      const result = await read.call(this);
      this.__gotChunk = true;
      return result;
    };
  });
  await mockGemini(page, () => ({ body: sse(text('# Lungs\n\n- **Alveoli**: tiny air sacs')) }));
  await saveKey(page);
  await page.setInputFiles('#doc-input', pdf());
  await expectProblem(page, 'CONNECTION_LOST', 'The connection dropped part-way');
  await expect(page.locator('#handbook h1')).toHaveText('Lungs');
  await expect(page.locator('#result-note')).toContainText('This handbook is incomplete');
  await expect(page.getByRole('button', { name: 'Save as PDF' })).toBeVisible();
  await expect(page.locator('#retry')).toBeVisible();
});

test('SUSPENDED: the screen locked while it was working', async ({ page }) => {
  await page.addInitScript(() => {
    let hidden = false;
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => hidden });
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    window.__setHidden = (value) => {
      hidden = value;
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = await mockGemini(page, async (call) => {
    if (!isGenerate(call)) return { json: {} };
    await gate;
    return { abort: 'failed' };
  });
  await saveKey(page);
  await page.setInputFiles('#doc-input', pdf());
  await expect.poll(() => calls.filter(isGenerate).length).toBe(1);
  await page.evaluate(() => window.__setHidden(true));
  await page.evaluate(() => window.__setHidden(false));
  release();
  await expectProblem(page, 'SUSPENDED', 'It stopped when the screen locked');
});

test('STOPPED: the Stop button', async ({ page }) => {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = await mockGemini(page, async () => {
    await gate;
    return answer('# Too late');
  });
  await saveKey(page);
  await page.setInputFiles('#doc-input', pdf());
  await expect.poll(() => calls.filter(isGenerate).length).toBe(1);
  await page.getByRole('button', { name: 'Stop' }).click();
  await expectProblem(page, 'STOPPED', 'Stopped');
  await expect(page.locator('#retry')).toBeVisible();
  release();
});

test('BLOCKED: a safety block with no text', async ({ page }) => {
  await mockGemini(page, () => ({ body: sse({ promptFeedback: { blockReason: 'SAFETY' } }) }));
  await saveKey(page);
  await page.setInputFiles('#doc-input', pdf());
  await expectProblem(page, 'BLOCKED', 'Gemini refused to finish');
});

test('RECITATION: stopped part-way keeps the partial text', async ({ page }) => {
  await mockGemini(page, () => ({ body: sse(text('# Lungs\n\n- **Alveoli**: air sacs', 'RECITATION')) }));
  await saveKey(page);
  await page.setInputFiles('#doc-input', pdf());
  await expectProblem(page, 'RECITATION', 'to avoid copying a book');
  await expect(page.locator('#handbook h1')).toHaveText('Lungs');
  await expect(page.locator('#result-note')).toContainText('This handbook is incomplete');
});

test('UNKNOWN: an unexpected finish reason still keeps the text and shows a code', async ({ page }) => {
  await mockGemini(page, () => ({ body: sse(text('# Lungs', 'OTHER')) }));
  await saveKey(page);
  await page.setInputFiles('#doc-input', pdf());
  await expectProblem(page, 'UNKNOWN (OTHER)', 'Something unexpected went wrong');
  await expect(page.locator('#handbook h1')).toHaveText('Lungs');
});

test('CUT_SHORT: a handbook that ran out of room says so', async ({ page }) => {
  await mockGemini(page, () => ({ body: sse(text('# Part one\n\n- point', 'MAX_TOKENS')) }));
  await saveKey(page);
  await page.setInputFiles('#doc-input', pdf());
  await expect(page.locator('#handbook h1')).toHaveText('Part one');
  await expect(page.locator('#result-note')).toContainText('This handbook stops early');
  await expect(page.locator('#result-note .code')).toHaveText('Code: CUT_SHORT');
});

test('NO_CONTENT: nothing to study in the file', async ({ page }) => {
  await mockGemini(page, () => answer('NO_CONTENT_FOUND: the pages are blank'));
  await saveKey(page);
  await page.setInputFiles('#doc-input', pdf('blank.pdf'));
  await expectProblem(page, 'NO_CONTENT', 'No study content found');
  await expect(page.locator('#problem-body')).toContainText('nothing to study in blank.pdf (the pages are blank)');
  await expect(page.locator('#result')).toBeHidden();
});

test('EMPTY_ANSWER: Gemini sent nothing back', async ({ page }) => {
  await mockGemini(page, () => ({ body: sse({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }] }) }));
  await saveKey(page);
  await page.setInputFiles('#doc-input', pdf());
  await expectProblem(page, 'EMPTY_ANSWER', 'empty answer');
});

test('SKILL_MISSING: the instructions file failed to load', async ({ page }) => {
  await page.route('**/skills/handbook/SKILL.md', (route) => route.fulfill({ status: 404, body: 'Not found' }));
  await mockGemini(page, () => answer('# Never'));
  await saveKey(page);
  await page.setInputFiles('#doc-input', pdf());
  await expectProblem(page, 'SKILL_MISSING', "The instructions for Gemini didn't load");
});

test('STORAGE_BLOCKED: the key still works for this visit when storage is blocked', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Storage is blocked', 'SecurityError'); };
  });
  await mockGemini(page, () => answer('# Lungs'));
  await saveKey(page);
  await expectProblem(page, 'STORAGE_BLOCKED', "won't remember your key");
  await page.setInputFiles('#doc-input', pdf());
  await expect(page.locator('#handbook h1')).toHaveText('Lungs');
});

test.describe('file problems', () => {
  test('TOO_BIG: a PDF over 50 MB', async ({ page }, testInfo) => {
    const big = testInfo.outputPath('huge.pdf');
    fs.mkdirSync(path.dirname(big), { recursive: true });
    fs.writeFileSync(big, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(50 * 1024 * 1024)]));
    const calls = await mockGemini(page, () => answer('# Never'));
    await saveKey(page);
    await page.setInputFiles('#doc-input', big);
    await expectProblem(page, 'TOO_BIG', 'This file is too big');
    await expect(page.locator('#problem-body')).toContainText('huge.pdf is 50.0 MB, and the limit is 50 MB');
    expect(calls).toHaveLength(0);
  });

  test('TOO_MANY_PHOTOS: more than 30 photos', async ({ page }) => {
    const photo = png(40, 40);
    await mockGemini(page, () => answer('# Never'));
    await saveKey(page);
    await page.setInputFiles('#photo-input', Array.from({ length: 31 }, (_, i) => ({ name: `page-${i + 1}.png`, mimeType: 'image/png', buffer: photo })));
    await expectProblem(page, 'TOO_MANY_PHOTOS', 'Too many photos at once');
    await expect(page.locator('#problem-body')).toContainText('You picked 31. Choose up to 30 at a time');
  });

  test('MIXED_FILES: photos and a PDF together', async ({ page }) => {
    await mockGemini(page, () => answer('# Never'));
    await saveKey(page);
    await page.setInputFiles('#photo-input', [{ name: 'page.png', mimeType: 'image/png', buffer: png(40, 40) }, pdf()]);
    await expectProblem(page, 'MIXED_FILES', 'Choose one kind of file');
  });

  const FORMAT_CASES = [
    ['OLD_PPT', 'lecture.ppt', 'application/vnd.ms-powerpoint', 'older PowerPoint file'],
    ['KEYNOTE', 'lecture.key', 'application/x-iwork-keynote-sffkey', 'Keynote files need one export'],
    ['GOOGLE_SLIDES', 'lecture.gslides', 'application/vnd.google-apps.presentation', 'Google Slides need one download'],
    ['UNSUPPORTED', 'essay.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', "This kind of file can't be read"],
  ];
  for (const [code, name, mimeType, title] of FORMAT_CASES) {
    test(`${code}: ${name}`, async ({ page }) => {
      await mockGemini(page, () => answer('# Never'));
      await saveKey(page);
      await page.setInputFiles('#doc-input', { name, mimeType, buffer: Buffer.from('not readable here') });
      await expectProblem(page, code, title);
    });
  }

  test('FILE_UNREADABLE: a damaged PowerPoint file', async ({ page }) => {
    await mockGemini(page, () => answer('# Never'));
    await saveKey(page);
    await page.setInputFiles('#doc-input', pptx('damaged.pptx', Buffer.from('this is not a zip file at all')));
    await expectProblem(page, 'FILE_UNREADABLE', "This file can't be opened");
  });

  test('FILE_UNREADABLE: a damaged PDF', async ({ page }) => {
    await mockGemini(page, () => answer('# Never'));
    await saveKey(page);
    await page.setInputFiles('#doc-input', { name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('hello') });
    await expectProblem(page, 'FILE_UNREADABLE');
  });

  test('PASSWORD: a password-protected PowerPoint file', async ({ page }) => {
    await mockGemini(page, () => answer('# Never'));
    await saveKey(page);
    const encrypted = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]);
    await page.setInputFiles('#doc-input', pptx('locked.pptx', encrypted));
    await expectProblem(page, 'PASSWORD', 'locked with a password');
  });

  test('SLIDES_EMPTY: slides that are only unreadable pictures', async ({ page }) => {
    await mockGemini(page, () => answer('# Never'));
    await saveKey(page);
    const deck = buildPptx([{ file: 'slide1.xml', pictures: [{ name: 'image1.emf', data: Buffer.from('EMF picture') }] }]);
    await page.setInputFiles('#doc-input', pptx('pictures-only.pptx', deck));
    await expectProblem(page, 'SLIDES_EMPTY', 'Nothing readable in these slides');
  });

  test('PHOTO_UNREADABLE: a photo the browser cannot open', async ({ page }) => {
    await mockGemini(page, () => answer('# Never'));
    await saveKey(page);
    await page.setInputFiles('#photo-input', [{ name: 'scan.heic', mimeType: 'image/heic', buffer: Buffer.from('not really a photo') }]);
    await expectProblem(page, 'PHOTO_UNREADABLE', "A photo couldn't be opened");
    await expect(page.locator('#problem-body')).toContainText('scan.heic');
  });

  test('UPDATE_IOS: PowerPoint needs a newer iOS', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'DecompressionStream', { configurable: true, value: undefined });
    });
    await mockGemini(page, () => answer('# Never'));
    await saveKey(page);
    await page.setInputFiles('#doc-input', pptx('lecture.pptx', buildPptx([{ file: 'slide1.xml', title: 'Lungs' }])));
    await expectProblem(page, 'UPDATE_IOS', 'This needs a newer iOS');
  });
});
