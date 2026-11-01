// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const {
  answer, buildPptx, expectProblem, isGenerate, jpegSize, mockGemini, pdf, png, pptx, respirationDeck, saveKey, stubPrint,
} = require('./fixtures');

test.beforeEach(async ({ page }) => stubPrint(page));

const imageParts = (parts) => parts.filter((part) => part.inlineData && part.inlineData.mimeType === 'image/jpeg');
const textOf = (parts) => parts.filter((part) => part.text).map((part) => part.text).join('\n');

test.describe('PowerPoint slides', () => {
  test('a lecture deck is read in presentation order, with Unicode text and its pictures', async ({ page }) => {
    const calls = await mockGemini(page, () => answer('# Respiration physiology\n\n- **Alveoli**: air sacs'));
    await saveKey(page);
    const deck = await respirationDeck(page);
    await page.setInputFiles('#doc-input', pptx('Respiration_lecture.pptx', deck));
    await expect(page.locator('#handbook h1')).toHaveText('Respiration physiology');

    const [call] = calls.filter(isGenerate);
    const { parts } = call.body.contents[0];
    const headings = parts.filter((part) => part.text && part.text.startsWith('Slide ')).map((part) => part.text.split('\n')[0]);
    expect(headings).toEqual([
      'Slide 1 of 5: Respiration Physiology',
      'Slide 2 of 5: Functions of the respiratory system',
      'Slide 3 of 5: Conducting zone',
      'Slide 4 of 5: Lung Capacities',
      'Slide 5 of 5: Gas transport',
    ]);
    const all = textOf(parts);
    expect(all).toContain('Brings O₂ into the body and removes CO₂');
    expect(all).toContain('  - by controlling how much CO₂ is breathed out');
    expect(all).toContain('— no gas exchange here');
    expect(all).toContain('Haemoglobin – carries most O₂ as oxyhaemoglobin');
    expect(all).toContain('(HCO₃⁻)');

    // Each picture follows its own slide's text, downscaled to at most 1600 px.
    expect(imageParts(parts)).toHaveLength(2);
    const after = (heading) => parts[parts.findIndex((part) => part.text && part.text.startsWith(heading)) + 1];
    const airway = after('Slide 3 of 5');
    const capacities = after('Slide 4 of 5');
    expect(airway.inlineData.mimeType).toBe('image/jpeg');
    expect(capacities.inlineData.mimeType).toBe('image/jpeg');
    expect(jpegSize(Buffer.from(airway.inlineData.data, 'base64'))).toEqual({ width: 1600, height: 1067 });
    expect(jpegSize(Buffer.from(capacities.inlineData.data, 'base64'))).toEqual({ width: 900, height: 600 });
    expect(parts.at(-1).text).toBe('Make my study handbook from these slides (Respiration_lecture.pptx (5 slides)). Each slide\'s text, tables, chart data, SmartArt and speaker notes come first, followed by its pictures.');
  });

  test('speaker notes, tables, charts and SmartArt are included; hidden slides, EMF and tiny pictures are not', async ({ page }) => {
    const calls = await mockGemini(page, () => answer('# Lung volumes'));
    await saveKey(page);
    const deck = buildPptx([
      {
        file: 'slide2.xml',
        title: 'Lung volumes',
        bullets: ['Measured with a spirometer'],
        notes: 'Ask the class which volume can never be breathed out.',
        table: [['Volume', 'Meaning'], ['Tidal volume', 'Air moved in one quiet breath'], ['Residual volume', 'Air left after breathing out fully']],
        chart: { title: 'Breathing rate', series: 'Breaths per minute', categories: ['Rest', 'Exercise'], values: [12, 30] },
      },
      { file: 'slide9.xml', title: 'Not shown today', bullets: ['SECRET hidden slide'], hidden: true },
      {
        file: 'slide1.xml',
        title: 'Control of breathing',
        smartArt: ['Rising CO₂', 'Chemoreceptors', 'Medulla', 'Faster breathing'],
        pictures: [{ name: 'image3.emf', data: Buffer.from('not an image the browser can draw') }, { name: 'bullet.png', data: png(24, 24) }],
      },
    ]);
    await page.setInputFiles('#doc-input', pptx('volumes.pptx', deck));
    await expect(page.locator('#handbook h1')).toHaveText('Lung volumes');

    const { parts } = calls.filter(isGenerate)[0].body.contents[0];
    const all = textOf(parts);
    expect(all).toContain('Slide 1 of 2: Lung volumes');
    expect(all).toContain('Slide 2 of 2: Control of breathing');
    expect(all).toContain('Speaker notes: Ask the class which volume can never be breathed out.');
    expect(all).not.toContain('Speaker notes: 7');
    expect(all).toContain('| Volume | Meaning |');
    expect(all).toContain('| Tidal volume | Air moved in one quiet breath |');
    expect(all).toContain('Chart "Breathing rate": Breaths per minute: Rest = 12, Exercise = 30');
    expect(all).toContain('SmartArt: Rising CO₂ | Chemoreceptors | Medulla | Faster breathing');
    expect(all).not.toContain('SECRET');
    expect(imageParts(parts)).toHaveLength(0);
  });

  test('pptx.js can be used on its own (for checking real decks locally)', async ({ page }) => {
    await page.goto('/');
    const deck = await respirationDeck(page);
    const result = await page.evaluate(async (base64) => {
      const { readPptx } = await import('./pptx.js');
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const { slides, pictures, skipped } = await readPptx(new File([bytes], 'deck.pptx'));
      return {
        pictures,
        skipped,
        slides: slides.map((slide) => ({
          number: slide.number,
          title: slide.title,
          lines: slide.lines.length,
          images: slide.images.map((image) => `${image.width}x${image.height}`),
          bytes: slide.images.reduce((sum, image) => sum + image.blob.size, 0),
        })),
      };
    }, deck.toString('base64'));
    expect(result.pictures).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.slides.map((slide) => slide.title)).toEqual(['Respiration Physiology', 'Functions of the respiratory system', 'Conducting zone', 'Lung Capacities', 'Gas transport']);
    expect(result.slides[2].images).toEqual(['1600x1067']);
    expect(result.slides[3].images).toEqual(['900x600']);
    expect(result.slides[3].lines).toBe(0);
    expect(result.slides[2].bytes).toBeGreaterThan(0);
  });
});

test.describe('photos', () => {
  test('several photos become one request, downscaled on the phone', async ({ page }) => {
    const calls = await mockGemini(page, () => answer('# Photos of my notes'));
    await saveKey(page);
    await page.setInputFiles('#photo-input', [
      { name: 'whiteboard.png', mimeType: 'image/png', buffer: png(3000, 1200) },
      { name: 'textbook.png', mimeType: 'image/png', buffer: png(800, 600) },
      { name: 'diagram.png', mimeType: 'image/png', buffer: png(1200, 2400) },
    ]);
    await expect(page.locator('#handbook h1')).toHaveText('Photos of my notes');
    const { parts } = calls.filter(isGenerate)[0].body.contents[0];
    expect(parts.filter((part) => part.text).map((part) => part.text)).toEqual([
      'Photo 1 of 3:', 'Photo 2 of 3:', 'Photo 3 of 3:',
      'Make my study handbook from these photos of notes, textbook pages or diagrams (3 photos), in order.',
    ]);
    const sizes = imageParts(parts).map((part) => jpegSize(Buffer.from(part.inlineData.data, 'base64')));
    expect(sizes).toEqual([{ width: 2048, height: 819 }, { width: 800, height: 600 }, { width: 1024, height: 2048 }]);
  });
});

test.describe('big files go through the Files API', () => {
  test('a PDF too big to send inline is uploaded, used by URI, then deleted', async ({ page }, testInfo) => {
    const big = testInfo.outputPath('big-respiration.pdf');
    fs.mkdirSync(path.dirname(big), { recursive: true });
    fs.writeFileSync(big, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(14 * 1024 * 1024)]));
    const fileUri = 'https://generativelanguage.googleapis.com/v1beta/files/abc123';
    const calls = await mockGemini(page, (call) => {
      if (call.url.endsWith('/upload/v1beta/files')) {
        // Like Google, expose the upload ID but not X-Goog-Upload-URL.
        return { json: {}, headers: { 'x-guploader-uploadid': 'up-123', 'x-goog-upload-status': 'active' } };
      }
      if (call.url.includes('upload_id=up-123')) {
        return { json: { file: { name: 'files/abc123', uri: fileUri, mimeType: 'application/pdf', state: 'PROCESSING' } } };
      }
      if (call.method === 'GET' && call.url.endsWith('/v1beta/files/abc123')) {
        return { json: { name: 'files/abc123', uri: fileUri, mimeType: 'application/pdf', state: 'ACTIVE' } };
      }
      if (call.method === 'DELETE') return { json: {} };
      return answer('# From a big PDF');
    });
    await saveKey(page);
    await page.setInputFiles('#doc-input', big);
    await expect(page.locator('#handbook h1')).toHaveText('From a big PDF', { timeout: 20000 });

    const start = calls.find((call) => call.url.endsWith('/upload/v1beta/files'));
    expect(start.headers['x-goog-upload-protocol']).toBe('resumable');
    expect(start.headers['x-goog-upload-command']).toBe('start');
    expect(start.headers['x-goog-upload-header-content-type']).toBe('application/pdf');
    const finalize = calls.find((call) => call.url.includes('upload_id=up-123'));
    expect(finalize.url).toBe('https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=up-123&upload_protocol=resumable');
    expect(finalize.headers['x-goog-upload-command']).toBe('upload, finalize');
    const [generate] = calls.filter(isGenerate);
    expect(generate.body.contents[0].parts[0]).toEqual({ fileData: { mimeType: 'application/pdf', fileUri } });
    await expect.poll(() => calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/v1beta/files/abc123'))).toBe(true);
  });

  test('small files still go inline', async ({ page }) => {
    const calls = await mockGemini(page, () => answer('# Small'));
    await saveKey(page);
    await page.setInputFiles('#doc-input', pdf());
    await expect(page.locator('#handbook h1')).toHaveText('Small');
    expect(calls.filter((call) => call.url.includes('/upload/'))).toHaveLength(0);
    expect(calls.filter(isGenerate)[0].body.contents[0].parts[0].inlineData.mimeType).toBe('application/pdf');
  });

  test('a failed upload is explained', async ({ page }, testInfo) => {
    const big = testInfo.outputPath('big.pdf');
    fs.mkdirSync(path.dirname(big), { recursive: true });
    fs.writeFileSync(big, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(14 * 1024 * 1024)]));
    await mockGemini(page, (call) => (call.url.includes('/upload/') ? { status: 503, json: { error: { code: 503, status: 'UNAVAILABLE', message: 'Backend error' } } } : answer('# Never')));
    await saveKey(page);
    await page.setInputFiles('#doc-input', big);
    await expectProblem(page, 'UPLOAD_FAILED', "The file didn't upload");
    await expect(page.locator('#retry')).toBeVisible();
  });

  test('a file Google could not process is explained', async ({ page }, testInfo) => {
    const big = testInfo.outputPath('big.pdf');
    fs.mkdirSync(path.dirname(big), { recursive: true });
    fs.writeFileSync(big, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(14 * 1024 * 1024)]));
    await mockGemini(page, (call) => {
      if (call.url.endsWith('/upload/v1beta/files')) return { json: {}, headers: { 'x-guploader-uploadid': 'up-9' } };
      if (call.url.includes('upload_id=up-9')) return { json: { file: { name: 'files/bad9', uri: 'https://generativelanguage.googleapis.com/v1beta/files/bad9', state: 'PROCESSING' } } };
      if (call.method === 'GET') return { json: { name: 'files/bad9', state: 'FAILED' } };
      return { json: {} };
    });
    await saveKey(page);
    await page.setInputFiles('#doc-input', big);
    await expectProblem(page, 'PROCESSING_FAILED', "Google couldn't read this file");
  });
});
