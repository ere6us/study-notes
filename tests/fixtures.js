// Shared helpers for the Playwright tests: a mocked Gemini API (generation and Files API), and
// synthetic PDF, PNG, JPEG and PowerPoint files built in memory. All example content is general
// biology (respiration), written for the tests.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { expect } = require('@playwright/test');

const KEY = 'AIzaFakeKeyForTests000000000000000000000';
const API = 'https://generativelanguage.googleapis.com';
const ROOT = path.join(__dirname, '..');
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, x-goog-api-key, x-goog-upload-protocol, x-goog-upload-command, x-goog-upload-header-content-length, x-goog-upload-header-content-type, x-goog-upload-offset',
  'access-control-expose-headers': 'x-guploader-uploadid, x-goog-upload-status',
};
const MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

const pdf = (name = 'respiration-lecture.pdf') => ({ name, mimeType: 'application/pdf', buffer: PDF_BYTES });
const sse = (...chunks) => chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join('');
const text = (value, finishReason) => ({
  candidates: [{ content: { role: 'model', parts: [{ text: value }] }, ...(finishReason ? { finishReason } : {}) }],
});
const thought = (value) => ({ candidates: [{ content: { role: 'model', parts: [{ text: value, thought: true }] } }] });
const apiError = (code, status, message, details = []) => ({ error: { code, status, message, details } });
const answer = (markdown) => ({ body: sse(text(markdown, 'STOP')) });
const dayLimit = () => ({
  status: 429,
  json: apiError(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota.', [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
  ]),
});
const minuteLimit = (seconds = 2, quotaId = 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier') => ({
  status: 429,
  json: apiError(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota.', [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${seconds}s` },
  ]),
});
const noFreeQuota = () => ({
  status: 429,
  json: apiError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0'),
});
const gone = (model = 'gemini-x') => ({ status: 404, json: apiError(404, 'NOT_FOUND', `models/${model} is not found for API version v1beta.`) });

const isGenerate = (call) => call.url.includes(':streamGenerateContent');
const modelOf = (call) => (/\/models\/([^:]+):/.exec(call.url) || [])[1];

/**
 * Routes every request to the Gemini API through respond(call, calls). respond returns
 * { status, json | body, headers } or { abort: 'failed' }, or a promise of one.
 */
async function mockGemini(page, respond) {
  const calls = [];
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const call = { url: request.url(), method: request.method(), headers: await request.allHeaders() };
    if (isGenerate(call)) call.body = request.postDataJSON();
    calls.push(call);
    const reply = (await respond(call, calls)) || { json: {} };
    try {
      if (reply.abort) return await route.abort(reply.abort);
      return await route.fulfill({
        status: reply.status || 200,
        headers: { ...CORS, 'content-type': reply.json ? 'application/json' : 'text/event-stream', ...(reply.headers || {}) },
        body: reply.json ? JSON.stringify(reply.json) : reply.body || '',
      });
    } catch {
      return undefined; // the page already gave up on this request (for example after Stop)
    }
  });
  return calls;
}

async function stubPrint(page) {
  // Headless WebKit has no print dialog, so stand in for it and fire the events Safari fires.
  await page.addInitScript(() => {
    window.__printCalls = 0;
    window.print = () => {
      window.__printCalls += 1;
      window.dispatchEvent(new Event('beforeprint'));
      window.dispatchEvent(new Event('afterprint'));
    };
  });
}

async function saveKey(page, key = KEY) {
  await page.goto('/');
  await page.getByLabel('Paste your key here').fill(key);
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByText('Choose PDF or slides', { exact: true })).toBeVisible();
}

async function expectProblem(page, code, title) {
  await expect(page.locator('#problem-code')).toHaveText(`Code: ${code}`);
  if (title) await expect(page.locator('#problem-title')).toContainText(title);
  await expect(page.locator('#problem')).toBeVisible();
}

function skillBody(name) {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
  return skill.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A plain RGB PNG; color(x, y) returns [r, g, b]. */
function png(width, height, color = (x) => (x % 40 < 20 ? [218, 24, 132] : [251, 226, 239])) {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = color(x, y);
      const offset = y * row + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A real JPEG, drawn by the browser (Node has no JPEG encoder). Call after page.goto. */
async function jpeg(page, width, height, label) {
  const base64 = await page.evaluate(async ({ w, h, caption }) => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    g.fillStyle = '#fbe2ef';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#da1884';
    g.fillRect(w * 0.1, h * 0.45, w * 0.8, h * 0.15);
    g.fillStyle = '#4a0e2e';
    g.font = `${Math.round(h / 10)}px sans-serif`;
    g.fillText(caption, w * 0.1, h * 0.3);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, { w: width, h: height, caption: label });
  return Buffer.from(base64, 'base64');
}

/** Width and height from a JPEG's start-of-frame marker. */
function jpegSize(buffer) {
  let i = 2;
  while (i < buffer.length - 9) {
    if (buffer[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buffer[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
    i += 2 + buffer.readUInt16BE(i + 2);
  }
  return null;
}

/** A zip file; entries are { name, data, store }. Names ending in "/" are directory entries. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data === undefined ? Buffer.alloc(0) : Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const stored = entry.store || entry.name.endsWith('/');
    const body = stored ? data : zlib.deflateRawSync(data);
    const method = stored ? 0 : 8;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RELS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function titleShape(title) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${esc(title)}</a:t></a:r></a:p></p:txBody></p:sp>`;
}

function bulletShape(bullets) {
  const paragraphs = bullets.map((bullet) => {
    const [level, value] = Array.isArray(bullet) ? bullet : [0, bullet];
    return `<a:p>${level ? `<a:pPr lvl="${level}"/>` : ''}<a:r><a:t>${esc(value)}</a:t></a:r></a:p>`;
  }).join('');
  return `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paragraphs}</p:txBody></p:sp>`;
}

function tableShape(rows) {
  const body = rows.map((cells) => `<a:tr h="0">${cells.map((cell) => `<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>${esc(cell)}</a:t></a:r></a:p></a:txBody></a:tc>`).join('')}</a:tr>`).join('');
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>${body}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

function notesXml(value) {
  const shape = (id, type, inner) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="s${id}"/><p:cNvSpPr/><p:nvPr><p:ph type="${type}"/></p:nvPr></p:nvSpPr><p:spPr/>${inner}</p:sp>`;
  const body = (words) => `<p:txBody><a:bodyPr/><a:p><a:r><a:t>${esc(words)}</a:t></a:r></a:p></p:txBody>`;
  return `<?xml version="1.0" encoding="UTF-8"?><p:notes ${NS}><p:cSld><p:spTree>${shape(2, 'sldImg', '')}${shape(3, 'body', body(value))}${shape(4, 'sldNum', body('7'))}</p:spTree></p:cSld></p:notes>`;
}

function chartXml({ title, series, categories, values }) {
  const points = (list) => list.map((value, i) => `<c:pt idx="${i}"><c:v>${esc(value)}</c:v></c:pt>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${esc(title)}</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>${esc(series)}</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:strCache>${points(categories)}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache>${points(values)}</c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`;
}

function smartArtXml(items) {
  const points = items.map((item, i) => `<dgm:pt modelId="${i + 1}"><dgm:t><a:bodyPr/><a:p><a:r><a:t>${esc(item)}</a:t></a:r></a:p></dgm:t></dgm:pt>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dgm:ptLst>${points}</dgm:ptLst></dgm:dataModel>`;
}

/**
 * A .pptx built in memory. slides are listed in presentation order, each with its own file name
 * (so the order can differ from the names): { file, title, bullets, pictures: [{ name, data }],
 * table, notes, chart, smartArt, hidden }.
 */
function buildPptx(slides) {
  const entries = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: 'ppt/media/' },
  ];
  const media = new Set();
  const presentationRels = [];
  const ids = [];
  slides.forEach((slide, i) => {
    const rId = `rId${i + 10}`;
    presentationRels.push(`<Relationship Id="${rId}" Type="${REL}/slide" Target="slides/${slide.file}"/>`);
    ids.push(`<p:sldId id="${256 + i}" r:id="${rId}"/>`);
    const rels = [];
    const shapes = [];
    if (slide.title) shapes.push(titleShape(slide.title));
    if (slide.bullets) shapes.push(bulletShape(slide.bullets));
    (slide.pictures || []).forEach((picture, k) => {
      rels.push(`<Relationship Id="rIdPic${k}" Type="${REL}/image" Target="../media/${picture.name}"/>`);
      shapes.push(`<p:pic><p:nvPicPr><p:cNvPr id="${20 + k}" name="Picture ${k + 1}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdPic${k}"/></p:blipFill><p:spPr/></p:pic>`);
      if (!media.has(picture.name)) {
        media.add(picture.name);
        entries.push({ name: `ppt/media/${picture.name}`, data: picture.data, store: /\.(jpe?g|png)$/i.test(picture.name) });
      }
    });
    if (slide.table) shapes.push(tableShape(slide.table));
    if (slide.notes) {
      rels.push(`<Relationship Id="rIdNotes" Type="${REL}/notesSlide" Target="../notesSlides/notes-${slide.file}"/>`);
      entries.push({ name: `ppt/notesSlides/notes-${slide.file}`, data: notesXml(slide.notes) });
    }
    if (slide.chart) {
      rels.push(`<Relationship Id="rIdChart" Type="${REL}/chart" Target="../charts/chart-${slide.file}"/>`);
      entries.push({ name: `ppt/charts/chart-${slide.file}`, data: chartXml(slide.chart) });
    }
    if (slide.smartArt) {
      rels.push(`<Relationship Id="rIdData" Type="${REL}/diagramData" Target="../diagrams/data-${slide.file}"/>`);
      entries.push({ name: `ppt/diagrams/data-${slide.file}`, data: smartArtXml(slide.smartArt) });
    }
    entries.push({
      name: `ppt/slides/${slide.file}`,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}${slide.hidden ? ' show="0"' : ''}><p:cSld><p:spTree>${shapes.join('')}</p:spTree></p:cSld></p:sld>`,
    });
    entries.push({ name: `ppt/slides/_rels/${slide.file}.rels`, data: `<?xml version="1.0" encoding="UTF-8"?><Relationships ${RELS}>${rels.join('')}</Relationships>` });
  });
  entries.push({
    name: 'ppt/presentation.xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${NS}><p:sldIdLst>${ids.join('')}</p:sldIdLst></p:presentation>`,
  });
  entries.push({ name: 'ppt/_rels/presentation.xml.rels', data: `<?xml version="1.0" encoding="UTF-8"?><Relationships ${RELS}>${presentationRels.join('')}</Relationships>` });
  return zip(entries);
}

/**
 * A deck shaped like a typical respiration-physiology lecture: a title slide, text-only slides,
 * a picture with a caption, a picture with only a short title, JPEG and PNG pictures, Unicode
 * (CO₂, en and em dashes), and slide files named out of presentation order.
 */
async function respirationDeck(page) {
  const airway = await jpeg(page, 2400, 1600, 'Conducting zone');
  const capacities = png(900, 600);
  return buildPptx([
    { file: 'slide3.xml', title: 'Respiration Physiology', bullets: ['Year 1 Physiology – Unit 4'] },
    { file: 'slide1.xml', title: 'Functions of the respiratory system', bullets: ['Brings O₂ into the body and removes CO₂', 'Helps keep blood pH steady', ['1', 'by controlling how much CO₂ is breathed out']] },
    { file: 'slide4.xml', title: 'Conducting zone', bullets: ['Air passages that warm, moisten and filter air — no gas exchange here'], pictures: [{ name: 'image1.jpeg', data: airway }] },
    { file: 'slide2.xml', title: 'Lung Capacities', pictures: [{ name: 'image2.png', data: capacities }] },
    { file: 'slide5.xml', title: 'Gas transport', bullets: ['Haemoglobin – carries most O₂ as oxyhaemoglobin', 'Most CO₂ travels in plasma as bicarbonate ions (HCO₃⁻)'] },
  ]);
}

const pptx = (name, buffer) => ({ name, mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer });

/** A handbook in the shape the handbook skill asks for, with every diagram type. */
const HANDBOOK_MD = `# Respiration physiology

## The airways

- **Conducting zone**: the airways that carry air to the lungs; no gas exchange happens here.
- **Respiratory zone**: the bronchioles and alveoli, where gas exchange happens.
- 💡 Memory hook: the conducting zone is the corridor, the alveoli are the rooms.

\`\`\`diagram
type: flow
title: Path of air into the lungs
- Nose
- Pharynx
- Larynx
- Trachea
- Bronchi
- Bronchioles
- Alveoli
\`\`\`

> **Must remember**
> - Gas exchange only happens in the respiratory zone.

## Breathing

**Don't mix these up**

| | Inspiration | Expiration |
| --- | --- | --- |
| Diaphragm | Contracts and flattens | Relaxes and domes up |
| Chest volume | Increases | Decreases |
| Air flow | Into the lungs | Out of the lungs |

\`\`\`diagram
type: cycle
title: The breathing cycle
- Diaphragm contracts
- Chest cavity expands
- Air flows in
- Diaphragm relaxes
- Air flows out
\`\`\`

## Gas transport

- **Haemoglobin**: carries most O₂ in red blood cells as oxyhaemoglobin.
- Most CO₂ travels in plasma as bicarbonate ions.

\`\`\`diagram
type: tree
title: How CO₂ travels in blood
- Carbon dioxide
  - As bicarbonate ions in plasma
  - Bound to haemoglobin
  - Dissolved in plasma
\`\`\`

> **Must remember**
> - O₂ rides on haemoglobin; most CO₂ rides as bicarbonate.

## One-page revision sheet

1. Air path: nose → pharynx → larynx → trachea → bronchi → bronchioles → alveoli
2. Inspiration: diaphragm contracts, chest volume up, air in
3. Haemoglobin carries most O₂

## Test yourself

1. Where does gas exchange happen?
2. Why does air flow in when the diaphragm contracts, not when it relaxes?

## Answers

1. In the alveoli, in the respiratory zone.
2. Contracting enlarges the chest, so pressure inside falls below the air outside.
`;

/** An answer in the shape the explain skill asks for. */
const EXPLAIN_MD = `# Breathing, explained simply

## Why we breathe

Every cell needs oxygen to release energy from food, and makes carbon dioxide as waste. Breathing swaps the two.

**Definition (from your notes):** Ventilation is the movement of air into and out of the lungs.

Example: after climbing stairs you breathe faster, because your muscles are using more oxygen.

- 💡 Think of it like: a fireplace that needs fresh air in and smoke out to keep burning.

\`\`\`diagram
type: cycle
title: Breathing in and out
- Diaphragm contracts and flattens
- Chest cavity gets bigger
- Air flows into the lungs
- Diaphragm relaxes
- Air is pushed out
\`\`\`

> **Check yourself**
> 1. What gas do cells need to release energy?
> 2. Why do you breathe faster when you exercise?

## Quick recap

- Cells need O₂ and make CO₂.
- The diaphragm does most of the work of breathing.

## Answers

### Why we breathe

1. Oxygen.
2. Working muscles use more oxygen and make more CO₂.
`;

module.exports = {
  API, CORS, EXPLAIN_MD, HANDBOOK_MD, KEY, MODELS, PDF_BYTES, ROOT,
  answer, apiError, buildPptx, dayLimit, expectProblem, gone, isGenerate, jpeg, jpegSize, minuteLimit,
  mockGemini, modelOf, noFreeQuota, pdf, png, pptx, respirationDeck, saveKey, skillBody, sse, stubPrint,
  text, thought, zip,
};
