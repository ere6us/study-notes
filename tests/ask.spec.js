// @ts-check
// Asking about a passage: she selects words in her handbook, taps Ask about this, and the answer
// appears in a box right under that passage, on screen, after a reload and in the PDF.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const {
  HANDBOOK_MD, KEY, ROOT, answer, dayLimit, isGenerate, minuteLimit, mockGemini, modelOf, pdf, saveKey, skillBody, sse, stubPrint, text,
} = require('./fixtures');

const ASK_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.8-flash'];
const ANSWER = [
  'The **conducting zone** only moves air: its walls are too thick for gases to pass through.',
  '',
  '- It warms, cleans and moistens the air.',
  '- Beyond your notes: think of it as the hallway to the alveoli.',
].join('\n');
const ANSWERING = fs.readFileSync(path.join(ROOT, 'love-notes.md'), 'utf8')
  .split(/^## Answering$/m)[1].split(/^## /m)[0]
  .split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2).trim());

test.beforeEach(async ({ page }) => stubPrint(page));

const asks = (calls) => calls.filter(isGenerate);
const conducting = (page) => page.locator('#handbook li', { hasText: 'Conducting zone' }).first();
// The handbook's own paragraph (answer boxes quote it too, so only direct children count).
const dontMix = (page) => page.locator('#handbook > p', { hasText: "Don't mix these up" });
const boxIn = (item) => item.locator(':scope > .qa');
const savedQa = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('handbook.last') || '{}').qa || []);

/** Opens the app with a handbook she made earlier, as saved on her phone. */
async function openHandbook(page) {
  await page.goto('/');
  await page.evaluate(({ key, md }) => {
    localStorage.setItem('handbook.geminiKey', key);
    localStorage.setItem('handbook.last', JSON.stringify({ name: 'respiration-lecture.pdf', md, mode: 'handbook', notes: [], backup: '' }));
  }, { key: KEY, md: HANDBOOK_MD });
  await page.reload();
  await expect(page.locator('#handbook h1')).toHaveText('Respiration physiology');
}

/** Selects all the words of an element, as a long-press and drag would. */
async function select(locator) {
  await locator.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

/** Selects the element's words, taps Ask about this, then taps a quick question or types one. */
async function ask(page, locator, question = 'Explain simply') {
  await select(locator);
  await page.locator('#ask').click();
  await expect(page.locator('#ask-dialog')).toBeVisible();
  const chip = page.locator('#ask-dialog .chip', { hasText: question });
  if (await chip.count()) {
    await chip.click();
  } else {
    await page.locator('#ask-input').fill(question);
    await page.locator('#ask-send').click();
  }
  await expect(page.locator('#ask-dialog')).toBeHidden();
}

/** Gemini's reply as an open stream: the headers arrive at once, then window.__push(text) and window.__end(). */
async function openStream(page) {
  await page.evaluate(() => {
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (!String(input).includes(':streamGenerateContent')) return realFetch(input, init);
      const body = new ReadableStream({
        start(controller) {
          window.__push = (chunk) => controller.enqueue(new TextEncoder().encode(chunk));
          window.__end = () => controller.close();
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    };
  });
}

test('Ask about this appears for words selected in the handbook, not elsewhere, and goes with the selection', async ({ page }) => {
  await mockGemini(page, () => answer('Never needed.'));
  await openHandbook(page);
  const button = page.locator('#ask');
  await select(page.locator('.dedication'));
  await page.waitForTimeout(300);
  await expect(button).toBeHidden();

  await select(conducting(page));
  await expect(button).toBeVisible();
  await expect(button).toHaveText('Ask about this');
  const layout = await page.evaluate(() => {
    const ask = document.getElementById('ask');
    const save = document.getElementById('save-pdf').getBoundingClientRect();
    const box = ask.getBoundingClientRect();
    return { inBar: document.getElementById('actions').contains(ask), above: box.bottom <= save.top, wide: box.width > save.width };
  });
  expect(layout).toEqual({ inBar: true, above: true, wide: true });

  // iOS often clears the selection as the button is tapped, so the button waits a moment before going.
  await page.evaluate(() => document.getSelection().removeAllRanges());
  await page.waitForTimeout(200);
  await expect(button).toBeVisible();
  await expect(button).toBeHidden({ timeout: 3000 });
});

test('Ask about this stays hidden while a handbook is still being written', async ({ page }) => {
  await saveKey(page);
  await openStream(page);
  await page.setInputFiles('#doc-input', pdf());
  await expect.poll(() => page.evaluate(() => typeof window.__push)).toBe('function');
  await page.evaluate((chunk) => window.__push(chunk), sse(text('# Lungs\n\n- **Alveoli**: tiny air sacs\n')));
  await expect(page.locator('#handbook li')).toHaveText('Alveoli: tiny air sacs');
  await select(page.locator('#handbook li'));
  await page.waitForTimeout(400);
  await expect(page.locator('#ask')).toBeHidden();

  await page.evaluate((chunk) => {
    window.__push(chunk);
    window.__end();
  }, sse(text('- **Bronchi**: the two main airways\n', 'STOP')));
  await expect(page.getByRole('button', { name: 'Save as PDF' })).toBeVisible();
  await select(page.locator('#handbook li').first());
  await expect(page.locator('#ask')).toBeVisible();
});

test('a selection that iOS clears as the button is tapped is still the one asked about', async ({ page }) => {
  await mockGemini(page, () => answer('A memory trick.'));
  await openHandbook(page);
  await select(page.locator('#handbook td', { hasText: 'Contracts and flattens' }));
  await expect(page.locator('#ask')).toBeVisible();
  await page.evaluate(() => document.getSelection().removeAllRanges());
  await page.locator('#ask').click();
  await expect(page.locator('#ask-quote')).toHaveText('“Contracts and flattens”');
  await page.locator('#ask-dialog .chip', { hasText: 'Memory trick' }).click();
  const box = page.locator('#handbook .table-wrap + .qa');
  await expect(box.locator('.qa-question')).toHaveText('You asked: Give me a memory trick for this.');
  await expect(box.locator('.qa-answer')).toHaveText('A memory trick.');
});

test('a question sends the handbook text, the passage and the question to the lightest free model', async ({ page }) => {
  const calls = await mockGemini(page, () => ({ body: sse(text(ANSWER.slice(0, 40)), text(ANSWER.slice(40), 'STOP')) }));
  await openHandbook(page);
  const item = conducting(page);
  await ask(page, item, 'Why is it called the conducting zone?');
  const box = boxIn(item);
  await expect(box).toHaveAttribute('data-state', 'done');
  await expect(box.locator('.qa-quote')).toHaveText(/^“Conducting zone: the airways that carry air to the lungs; no gas exchange…”$/);
  await expect(box.locator('.qa-question')).toHaveText('You asked: Why is it called the conducting zone?');
  await expect(box.locator('.qa-answer strong')).toHaveText('conducting zone');
  await expect(box.locator('.qa-answer li').last()).toHaveText('Beyond your notes: think of it as the hallway to the alveoli.');

  expect(asks(calls)).toHaveLength(1);
  const [call] = asks(calls);
  expect(modelOf(call)).toBe('gemini-3.5-flash-lite');
  expect(call.headers['x-goog-api-key']).toBe(KEY);
  expect(call.body.systemInstruction.parts[0].text).toBe(skillBody('ask'));
  expect(call.body.generationConfig).toBeUndefined();
  const { parts } = call.body.contents[0];
  expect(parts).toHaveLength(1);
  expect(Object.keys(parts[0])).toEqual(['text']);
  expect(parts[0].text).toContain(`<handbook>\n${HANDBOOK_MD}\n</handbook>`);
  expect(parts[0].text).toContain('<passage>\nConducting zone: the airways that carry air to the lungs; no gas exchange happens here.\n</passage>');
  expect(parts[0].text.endsWith('My question: Why is it called the conducting zone?')).toBe(true);
});

test('a used-up daily limit on the light model moves on to the next free model', async ({ page }) => {
  const calls = await mockGemini(page, (call) => (modelOf(call) === 'gemini-3.5-flash-lite' ? dayLimit() : answer('From the next model.')));
  await openHandbook(page);
  const item = conducting(page);
  await ask(page, item);
  await expect(boxIn(item).locator('.qa-answer')).toHaveText('From the next model.');
  expect(asks(calls).map(modelOf)).toEqual(['gemini-3.5-flash-lite', 'gemini-3.6-flash']);
});

test('a per-minute limit does not move on: the box counts down, then Try again answers', async ({ page }) => {
  let first = true;
  const calls = await mockGemini(page, () => {
    if (first) {
      first = false;
      return minuteLimit(2);
    }
    return answer('Answer after the wait.');
  });
  await openHandbook(page);
  const item = conducting(page);
  await ask(page, item);
  const box = boxIn(item);
  await expect(box.locator('.qa-problem .code')).toHaveText('Code: LIMIT_MINUTE');
  await expect(box.locator('.qa-problem .notice-title')).toHaveText('Too many requests this minute');
  const retry = box.locator('.qa-retry');
  await expect(retry).toBeDisabled();
  await expect(retry).toHaveText(/Try again in \d s/);
  await expect(retry).toBeEnabled({ timeout: 5000 });
  expect(asks(calls).map(modelOf)).toEqual(['gemini-3.5-flash-lite']);
  await retry.click();
  await expect(box.locator('.qa-answer')).toHaveText('Answer after the wait.');
  await expect(box.locator('.qa-problem')).toHaveCount(0);
  expect(asks(calls).map(modelOf)).toEqual(['gemini-3.5-flash-lite', 'gemini-3.5-flash-lite']);
});

test("when every free model has used today's allowance, the box says when it resets", async ({ page }) => {
  const calls = await mockGemini(page, () => dayLimit());
  await openHandbook(page);
  const item = conducting(page);
  await ask(page, item);
  const box = boxIn(item);
  await expect(box.locator('.qa-problem .code')).toHaveText('Code: ASK_LIMIT_DAY');
  await expect(box.locator('.qa-problem .notice-title')).toHaveText("You've used today's free questions");
  await expect(box.locator('.qa-problem')).toContainText(/reset at \d{1,2}:\d{2}/);
  await expect(box.locator('.qa-retry')).toHaveCount(0);
  await expect(box).toHaveAttribute('data-state', 'failed');
  expect(asks(calls).map(modelOf)).toEqual(ASK_MODELS);
  expect(await savedQa(page)).toEqual([]);
});

test('offline: the box says so, and Try again works once she is back online', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => !window.__offline });
  });
  const calls = await mockGemini(page, () => answer('Back online.'));
  await openHandbook(page);
  await page.evaluate(() => { window.__offline = true; });
  const item = conducting(page);
  await ask(page, item);
  const box = boxIn(item);
  await expect(box.locator('.qa-problem .code')).toHaveText('Code: OFFLINE');
  await expect(box.locator('.qa-problem .notice-title')).toHaveText("You're offline");
  expect(asks(calls)).toHaveLength(0);
  await page.evaluate(() => { window.__offline = false; });
  await box.locator('.qa-retry').click();
  await expect(box.locator('.qa-answer')).toHaveText('Back online.');
});

test('each answer sits right under its passage: list item, paragraph, table, must-remember box and diagram', async ({ page }) => {
  await mockGemini(page, () => answer('A short answer.'));
  await openHandbook(page);
  const item = conducting(page);
  const paragraph = dontMix(page);
  const table = page.locator('#handbook .table-wrap');
  const mustRemember = page.locator('#handbook blockquote', { hasText: 'Gas exchange only happens' });
  const figure = page.locator('#handbook figure.diagram-figure', { has: page.locator('svg.diagram-flow') });

  await ask(page, item);
  await ask(page, paragraph);
  await ask(page, table.locator('td', { hasText: 'Contracts and flattens' }));
  await ask(page, mustRemember.locator('li', { hasText: 'Gas exchange only happens' }));
  await ask(page, figure.locator('tspan', { hasText: 'Trachea' }));
  await expect(page.locator('#handbook .qa[data-state="done"]')).toHaveCount(5);

  // A list item holds its answer under its own words, so lists keep their numbering.
  await expect(boxIn(item)).toHaveCount(1);
  const after = (locator) => locator.evaluate((el) => Boolean(el.nextElementSibling && el.nextElementSibling.matches('.qa')));
  expect(await after(paragraph)).toBe(true);
  expect(await after(table)).toBe(true);
  expect(await after(mustRemember)).toBe(true);
  expect(await after(figure)).toBe(true);
  await expect(page.locator('#handbook table .qa, #handbook blockquote .qa, #handbook figure .qa')).toHaveCount(0);
  await expect(page.locator('#handbook .qa .qa-question').first()).toHaveText('You asked: Explain this simply.');
});

test('questions on the same passage stack in order, and a follow-up on an answer joins them', async ({ page }) => {
  let n = 0;
  await mockGemini(page, () => {
    n += 1;
    return answer(`Answer ${n}.`);
  });
  await openHandbook(page);
  const item = conducting(page);
  const term = item.locator('strong').first();
  await ask(page, term, 'Explain simply');
  await expect(boxIn(item).nth(0)).toHaveAttribute('data-state', 'done');
  await ask(page, term, 'Give an example');
  await expect(boxIn(item).nth(1)).toHaveAttribute('data-state', 'done');
  await ask(page, boxIn(item).nth(0).locator('.qa-answer p'), 'Why is that?');
  await expect(boxIn(item)).toHaveCount(3);
  await expect(boxIn(item).nth(2)).toHaveAttribute('data-state', 'done');
  await expect(boxIn(item).locator('.qa-question')).toHaveText([
    'You asked: Explain this simply.',
    'You asked: Give me an everyday example of this.',
    'You asked: Why is that?',
  ]);
  await expect(boxIn(item).locator('.qa-answer')).toHaveText(['Answer 1.', 'Answer 2.', 'Answer 3.']);
  expect((await savedQa(page)).map((entry) => entry.question)).toEqual([
    'Explain this simply.', 'Give me an everyday example of this.', 'Why is that?',
  ]);
});

test('questions are saved with the handbook and placed again after a reload, or under My questions', async ({ page }) => {
  await mockGemini(page, () => answer('Kept answer.'));
  await openHandbook(page);
  const item = conducting(page);
  await ask(page, item);
  await expect(boxIn(item)).toHaveAttribute('data-state', 'done');
  const edit = (change) => page.evaluate((how) => {
    const last = JSON.parse(localStorage.getItem('handbook.last') || '{}');
    Object.assign(last.qa[0], how);
    localStorage.setItem('handbook.last', JSON.stringify(last));
  }, change);

  await page.reload();
  await expect(boxIn(item).locator('.qa-answer')).toHaveText('Kept answer.');
  const [saved] = await savedQa(page);
  expect(saved).toMatchObject({ question: 'Explain this simply.', answer: 'Kept answer.' });
  expect(saved.fp).toMatch(/^Conducting zone: the airways/);
  expect(saved.quote).toMatch(/^Conducting zone: the airways that carry air to the lungs/);

  // If the handbook's layout ever changes (say, in an app update), her selected words find the passage.
  await edit({ index: 999 });
  await page.reload();
  await expect(boxIn(item).locator('.qa-answer')).toHaveText('Kept answer.');

  // If they can't be found either, the question moves to My questions at the end.
  await edit({ index: 999, quote: 'Words that are nowhere in this handbook' });
  await page.reload();
  const orphans = page.locator('#handbook > .qa-orphans');
  await expect(orphans.locator('h2')).toHaveText('My questions');
  await expect(orphans.locator('.qa .qa-answer')).toHaveText('Kept answer.');
  expect(await orphans.evaluate((el) => el === el.parentElement.lastElementChild)).toBe(true);
  await expect(item.locator('.qa')).toHaveCount(0);
});

test('Remove takes a question away, on screen and in the saved handbook', async ({ page }) => {
  await mockGemini(page, () => answer('Soon gone.'));
  await openHandbook(page);
  const item = conducting(page);
  await ask(page, item);
  const box = boxIn(item);
  await expect(box).toHaveAttribute('data-state', 'done');
  await box.getByRole('button', { name: 'Remove this question' }).click();
  await expect(page.locator('#handbook .qa')).toHaveCount(0);
  expect(await savedQa(page)).toEqual([]);
  await page.reload();
  await expect(page.locator('#handbook h1')).toHaveText('Respiration physiology');
  await expect(page.locator('#handbook .qa')).toHaveCount(0);
});

test('Save as PDF prints each answer under its passage, without the Remove button', async ({ page }) => {
  await mockGemini(page, () => answer(ANSWER));
  await openHandbook(page);
  const item = conducting(page);
  await ask(page, item);
  const box = boxIn(item);
  await expect(box).toHaveAttribute('data-state', 'done');
  await page.emulateMedia({ media: 'print' });
  await expect(box).toBeVisible();
  await expect(box.locator('.qa-question')).toBeVisible();
  await expect(box.locator('.qa-answer')).toContainText('only moves air');
  await expect(box.locator('.qa-remove')).toBeHidden();
  await expect(page.locator('#ask')).toBeHidden();
  const style = await box.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      split: s.breakInside || s.pageBreakInside,
      colors: s.getPropertyValue('print-color-adjust') || s.getPropertyValue('-webkit-print-color-adjust'),
    };
  });
  expect(style.split).toBe('avoid');
  expect(style.colors).toBe('exact');
});

test('what she types and what Gemini answers can never run as code', async ({ page }) => {
  const evil = [
    'Answer <script>window.__pwned = "script"</script>',
    '',
    '<img src=x onerror="window.__pwned = \'img\'">',
    '',
    '- [tap me](javascript:window.__pwned=\'link\')',
    '',
    '```diagram',
    'type: flow',
    '- <svg onload="window.__pwned = \'svg\'">',
    '- Alveoli',
    '```',
  ].join('\n');
  await mockGemini(page, () => answer(evil));
  await openHandbook(page);
  const item = conducting(page);
  const question = '<img src=x onerror="window.__pwned = \'question\'"> why?';
  await ask(page, item, question);
  const box = boxIn(item);
  await expect(box).toHaveAttribute('data-state', 'done');
  await expect(box.locator('.qa-question')).toHaveText(`You asked: ${question}`);
  await expect(box.locator('.qa-answer')).toContainText('<script>');
  await expect(box.locator('script, img, iframe, a, foreignObject, image, style')).toHaveCount(0);
  const attributes = await box.evaluate((root) => [...root.querySelectorAll('*')]
    .flatMap((el) => [...el.attributes].map((attr) => `${el.tagName}.${attr.name}=${attr.value}`)));
  expect(attributes.filter((attr) => /\.on|javascript:/i.test(attr))).toEqual([]);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  const [saved] = await savedQa(page);
  expect(saved.question).toBe(question);
});

test('while it answers, the box shows a love note, and Ask waits for one question at a time', async ({ page }) => {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  await mockGemini(page, async () => {
    await gate;
    return answer('Done.');
  });
  await openHandbook(page);
  const item = conducting(page);
  await ask(page, item);
  const box = boxIn(item);
  await expect(box.locator('.qa-wait-title')).toHaveText('Gemini is answering…');
  const line = box.locator('.love .love-line').last();
  await expect(line).toBeVisible();
  expect(ANSWERING).toContain(await line.textContent());
  await expect(box.locator('.love')).toHaveAttribute('aria-hidden', 'true');

  await select(dontMix(page));
  await expect(page.locator('#ask')).toBeVisible();
  await expect(page.locator('#ask')).toBeDisabled();
  release();
  await expect(box.locator('.qa-answer')).toHaveText('Done.');
  await expect(box.locator('.qa-wait')).toHaveCount(0);
  await expect(page.locator('#ask')).toBeEnabled();
  await expect(page.locator('#ask')).toHaveText('Ask about this');
});

test('the ask skill is a valid Agent Skill', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'ask', 'SKILL.md'), 'utf8');
  const front = skill.match(/^---\n([\s\S]*?)\n---\n/);
  expect(front).not.toBeNull();
  const header = front ? front[1] : '';
  expect(header).toMatch(/^name: ask$/m);
  const description = (header.match(/^description: (.+)$/m) || [])[1] || '';
  expect(description.length).toBeGreaterThan(20);
  expect(description.length).toBeLessThanOrEqual(1024);
  expect(skill).toContain('```diagram');
  expect(skill).toContain('Beyond your notes:');
  expect(ANSWERING.length).toBeGreaterThanOrEqual(6);
});
