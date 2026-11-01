// @ts-check
// The love notes shown while Gemini works (love-notes.md): reading the file, the rotation, the
// minute marks, the shuffle bags that keep repeats rare, {thing} and {time}, and the headline.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const {
  ROOT, answer, isGenerate, mockGemini, pdf, saveKey, sse, stubPrint, text, thought,
} = require('./fixtures');

const STAGES = ['getting ready', 'sending', 'reading', 'planning', 'writing', 'still waiting'];
const SENDING = ['Sending, one.', 'Sending, two.', 'Sending, three.', 'Sending, four.'];
const READING = 'Gemini is reading your notes…';
const T0 = new Date('2026-11-02T08:00:00Z');
const T1 = new Date('2026-11-02T09:00:00Z');

// Small, known pools, so these tests don't depend on the real copy.
const NOTES = `# Love notes

Anything that isn't a heading or a bullet is ignored.

## Getting ready
- Getting ready, one.

## Sending
${SENDING.map((line) => `- ${line}`).join('\n')}

## Reading
- Reading, one.
- Reading, two.
- Reading, three.

## Planning
- Planning your {thing}.

## Writing
- Writing your {thing}.

## Still waiting
- {time} in, still yours.
- {time} of patience.
`;

test.beforeEach(async ({ page }) => stubPrint(page));

const newest = (page) => page.locator('#love .love-line').last();

async function serveNotes(page, body = NOTES, status = 200) {
  await page.route('**/love-notes.md', (route) => route.fulfill({ status, contentType: 'text/markdown; charset=utf-8', body }));
}

/** Gemini answers only when release() is called. */
async function holdGemini(page) {
  const held = { calls: /** @type {any[]} */ ([]), release: () => {} };
  held.calls = await mockGemini(page, () => new Promise((resolve) => {
    held.release = () => resolve(answer('# Lungs\n\n- **Alveoli**: air sacs'));
  }));
  return held;
}

/** Keeps every line that appears, in order. */
async function recordLines(page) {
  await page.evaluate(() => {
    window.__shown = [];
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && node.classList.contains('love-line')) window.__shown.push(node.textContent);
        }
      }
    }).observe(document.getElementById('love'), { childList: true });
  });
}
const shown = (page) => page.evaluate(() => window.__shown);

/** Gemini's reply as an open stream: the headers arrive at once, and window.__push(text) sends more. */
async function openStream(page) {
  await page.evaluate(() => {
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (!String(input).includes(':streamGenerateContent')) return realFetch(input, init);
      const body = new ReadableStream({
        start(controller) {
          window.__push = (chunk) => controller.enqueue(new TextEncoder().encode(chunk));
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    };
  });
}

test('love-notes.md is read tolerantly, and the real file uses only known stages', async ({ page }) => {
  await page.goto('/');
  const messy = [
    '\uFEFF# Title',
    '- before any stage',
    'Some prose.',
    '## Sending  ',
    '- One',
    '* Two',
    '-not a bullet',
    '- One',
    '* * *',
    '### A sub-heading',
    '- Three',
    '## Empty',
    '##   Still Waiting ##',
    '- {time} in.',
    '- <img src=x onerror="window.__pwned = 1">',
  ].join('\r\n');
  const parsed = await page.evaluate(async (source) => {
    const { parseLoveNotes } = await import('./love-notes.js');
    return parseLoveNotes(source);
  }, messy);
  expect(parsed).toEqual({
    sending: ['One', 'Two', 'Three'],
    'still waiting': ['{time} in.', '<img src=x onerror="window.__pwned = 1">'],
  });

  const real = await page.evaluate(async () => {
    const { loadLoveNotes } = await import('./love-notes.js');
    return loadLoveNotes();
  });
  expect(STAGES).toEqual(expect.arrayContaining(Object.keys(real)));
  for (const stage of STAGES) expect(real[stage] ? real[stage].length : 0, stage).toBeGreaterThan(0);
  expect(fs.readFileSync(path.join(ROOT, 'love-notes.md'), 'utf8')).not.toMatch(/barbie|\bdumb\b|\bstupid\b/i);
});

test('if love-notes.md is missing there is no line, and the handbook still comes', async ({ page }) => {
  await serveNotes(page, 'Not found', 404);
  const gemini = await holdGemini(page);
  await saveKey(page);
  await recordLines(page);
  const notes = page.waitForResponse((response) => response.url().endsWith('/love-notes.md'));
  await page.setInputFiles('#doc-input', pdf());
  await notes;
  await expect.poll(() => gemini.calls.filter(isGenerate).length).toBe(1);
  await expect(page.locator('#working')).toBeVisible();
  await expect(page.locator('#love')).toBeHidden();
  gemini.release();
  await expect(page.locator('#handbook h1')).toHaveText('Lungs');
  expect(await shown(page)).toEqual([]);
});

for (const [mode, thing] of [['Handbook', 'handbook'], ['Explain simply', 'explanation']]) {
  test(`{thing} becomes "${thing}" in ${mode}, while planning and writing`, async ({ page }) => {
    await serveNotes(page);
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    await mockGemini(page, async () => {
      await gate;
      return { body: sse(thought('**Planning**'), text('# Lungs\n\n- **Alveoli**: air sacs', 'STOP')) };
    });
    await saveKey(page);
    await page.getByRole('radio', { name: new RegExp(mode) }).check();
    await recordLines(page);
    await page.setInputFiles('#doc-input', pdf());
    await expect(newest(page)).toHaveText(/^Sending/);
    // With motion allowed, the heart beats.
    expect(await newest(page).evaluate((el) => getComputedStyle(el, '::before').animationName)).toBe('love-beat');
    release();
    await expect(page.locator('#handbook h1')).toHaveText('Lungs');
    const lines = await shown(page);
    expect(lines).toContain(`Planning your ${thing}.`);
    expect(lines).toContain(`Writing your ${thing}.`);
    await expect(page.locator('#love')).toBeHidden();
  });
}

test.describe('with the clock under test control', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await serveNotes(page);
    await page.clock.install({ time: T0 });
  });

  test('a line shows at once, changes every 7 seconds, and the headline moves on to reading', async ({ page }) => {
    const gemini = await holdGemini(page);
    await saveKey(page);
    await page.clock.pauseAt(T1);
    await page.setInputFiles('#doc-input', pdf());
    await expect.poll(() => gemini.calls.filter(isGenerate).length).toBe(1);

    const status = page.locator('#status-text');
    await expect(status).toHaveText('Sending to Gemini…');
    await expect(newest(page)).toHaveText(/^Sending, (one|two|three|four)\.$/);
    const first = String(await newest(page).textContent());
    await page.clock.runFor(6000);
    await expect(newest(page)).toHaveText(first);
    await page.clock.runFor(1000);
    await expect(newest(page)).toHaveText(/^Sending, (one|two|three|four)\.$/);
    await expect(newest(page)).not.toHaveText(first);
    await expect(status).toHaveText('Sending to Gemini…');

    // No upload progress is available, so after the estimate (15 s for a small file) it says Gemini is reading.
    await page.clock.runFor(8000);
    await expect(status).toHaveText(READING);
    await expect(newest(page)).toHaveText(/^Reading, (one|two|three)\.$/);

    // The line is decoration: hidden from VoiceOver and kept out of the live status.
    await expect(page.locator('#love')).toHaveAttribute('aria-hidden', 'true');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    expect(await page.locator('#working').ariaSnapshot()).not.toContain('Reading,');
    // Reduced motion: a still heart, and lines swap without fading.
    expect(await newest(page).evaluate((el) => getComputedStyle(el, '::before').animationName)).toBe('none');
    await expect(page.locator('#love .love-line')).toHaveCount(1);
    gemini.release();
  });

  test('each full minute shows a "still waiting" line with the time, then the rotation carries on', async ({ page }) => {
    const gemini = await holdGemini(page);
    await saveKey(page);
    await page.clock.pauseAt(T1);
    await page.setInputFiles('#doc-input', pdf());
    await expect(newest(page)).toHaveText(/^Sending/);
    await page.clock.runFor(60_000);
    await expect(page.locator('#timer')).toHaveText('1:00');
    await expect(newest(page)).toHaveText(/^1 minute (in, still yours|of patience)\.$/);
    await page.clock.runFor(7_000);
    await expect(newest(page)).toHaveText(/^Reading, (one|two|three)\.$/);
    await page.clock.runFor(53_000);
    await expect(page.locator('#timer')).toHaveText('2:00');
    await expect(newest(page)).toHaveText(/^2 minutes (in, still yours|of patience)\.$/);
    gemini.release();
  });

  test('no line repeats until its stage has shown them all, and the next run carries on with unseen ones', async ({ page }) => {
    const gemini = await holdGemini(page);
    await saveKey(page);
    await recordLines(page);
    await page.clock.pauseAt(T1);
    const sending = async () => (await shown(page)).filter((line) => line.startsWith('Sending'));

    // Run 1 shows two of the four sending lines, and remembers the other two.
    await page.setInputFiles('#doc-input', pdf());
    await expect.poll(sending).toHaveLength(1);
    await page.clock.runFor(7000);
    await expect.poll(sending).toHaveLength(2);
    await expect.poll(() => gemini.calls.filter(isGenerate).length).toBe(1);
    gemini.release();
    await expect(page.locator('#handbook h1')).toHaveText('Lungs');
    const firstRun = await sending();
    const unseen = SENDING.filter((line) => !firstRun.includes(line));
    expect(unseen).toHaveLength(2);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('handbook.loveNotes') || '{}'));
    expect([...saved.sending.left].sort()).toEqual([...unseen].sort());

    // Run 2 shows those two first. Only then does a new round start, and never with the line just shown.
    await page.setInputFiles('#doc-input', pdf());
    await expect.poll(sending).toHaveLength(3);
    await page.clock.runFor(7000);
    await expect.poll(sending).toHaveLength(4);
    const round = await sending();
    expect(round.slice(2).sort()).toEqual([...unseen].sort());
    expect([...round].sort()).toEqual([...SENDING].sort());
    await page.clock.runFor(7000);
    await expect.poll(sending).toHaveLength(5);
    expect((await sending())[4]).not.toBe(round[3]);
    await expect.poll(() => gemini.calls.filter(isGenerate).length).toBe(2);
    gemini.release();
  });

  test('when Gemini starts answering early, it says reading at once, then planning, and never goes back', async ({ page }) => {
    await mockGemini(page, () => answer('# Never used'));
    await saveKey(page);
    await recordLines(page);
    await openStream(page);
    await page.clock.pauseAt(T1);
    await page.setInputFiles('#doc-input', pdf());

    const status = page.locator('#status-text');
    await expect(status).toHaveText(READING);
    await expect(newest(page)).toHaveText(/^Reading, (one|two|three)\.$/);
    await page.evaluate((chunk) => window.__push(chunk), sse(thought('**Planning the handbook**')));
    await expect(status).toHaveText('Planning your handbook…');
    await expect(newest(page)).toHaveText('Planning your handbook.');
    // The 15 s estimate passes, but the headline doesn't go back to reading or sending.
    await page.clock.runFor(20_000);
    await expect(status).toHaveText('Planning your handbook…');
    await expect(newest(page)).toHaveText('Planning your handbook.');
    const lines = await shown(page);
    const firstReading = lines.findIndex((line) => line.startsWith('Reading'));
    expect(firstReading).toBeGreaterThanOrEqual(0);
    expect(lines.slice(firstReading).filter((line) => line.startsWith('Sending'))).toEqual([]);
  });
});
