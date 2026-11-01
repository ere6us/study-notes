import { Problem } from './errors.js';
import { toJpeg } from './images.js';

// Reads a PowerPoint file (.pptx) entirely in the browser, with no libraries: a .pptx is a zip of XML
// files, and DecompressionStream inflates it. Independent of the page, so it can be run on its own:
//
//   import { readPptx } from './pptx.js';
//   const { slides, pictures, skipped } = await readPptx(file);
//   // slides[i] = { number, title, lines, notes, images: [{ blob, width, height, name }] }
//
// Slides come in presentation order (hidden slides left out). lines holds the text as bullets,
// plus tables, chart data and SmartArt text. Pictures are downscaled JPEGs; each media file is
// used once, and pictures the browser can't decode (EMF, WMF, ...) are skipped and counted.

const NS = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
};
const PICTURE = /\.(png|jpe?g|gif|bmp|webp|tiff?|heic|heif)$/i;
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp',
  webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif',
};

export async function readPptx(file, { maxEdge = 1600, maxPictures = 60, minPicture = 64, onSlide = () => {} } = {}) {
  const name = file.name || 'slides.pptx';
  if (typeof DecompressionStream === 'undefined') throw new Problem('UPDATE_IOS', { name });
  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    throw new Problem('FILE_UNREADABLE', { name });
  }
  const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  // A password-protected Office file isn't a zip but an encrypted "compound file".
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) throw new Problem('PASSWORD', { name });
  try {
    return await readDeck(openZip(buffer), { maxEdge, maxPictures, minPicture, onSlide });
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem('FILE_UNREADABLE', { name });
  }
}

async function readDeck(zip, options) {
  const presentationPart = 'ppt/presentation.xml';
  const presentation = parseXml(await zip.text(presentationPart));
  const presentationRels = await relationships(zip, presentationPart);
  const order = [...presentation.getElementsByTagNameNS(NS.p, 'sldId')]
    .map((slide) => presentationRels.get(slide.getAttributeNS(NS.r, 'id')))
    .filter(Boolean)
    .map((rel) => rel.target);
  const visible = [];
  for (const part of order) {
    const doc = parseXml(await zip.text(part));
    if (doc.documentElement.getAttribute('show') !== '0') visible.push({ part, doc });
  }

  const slides = [];
  const seen = new Set();
  let pictures = 0;
  let skipped = 0;
  for (let i = 0; i < visible.length; i += 1) {
    options.onSlide(i + 1, visible.length);
    const { part, doc } = visible[i];
    const rels = await relationships(zip, part);
    const slide = { number: i + 1, title: '', lines: [], notes: '', images: [] };

    for (const body of doc.getElementsByTagNameNS(NS.p, 'txBody')) {
      const type = placeholderType(body.parentNode);
      if (['sldNum', 'dt', 'ftr', 'hdr'].includes(type)) continue;
      const paragraphs = paragraphsOf(body);
      if (!paragraphs.length) continue;
      if ((type === 'title' || type === 'ctrTitle') && !slide.title) {
        slide.title = paragraphs.map((p) => p.text).join(' ');
      } else {
        for (const p of paragraphs) slide.lines.push(`${'  '.repeat(p.level)}- ${p.text}`);
      }
    }
    for (const table of doc.getElementsByTagNameNS(NS.a, 'tbl')) slide.lines.push(...tableLines(table));

    for (const rel of rels.values()) {
      if (rel.type.endsWith('/chart')) {
        const chart = await optionalXml(zip, rel.target);
        if (chart) slide.lines.push(...chartLines(chart));
      } else if (rel.type.endsWith('/diagramData')) {
        const data = await optionalXml(zip, rel.target);
        const words = data ? paragraphsOf(data).map((p) => p.text) : [];
        if (words.length) slide.lines.push(`SmartArt: ${words.join(' | ')}`);
      } else if (rel.type.endsWith('/notesSlide')) {
        const notes = await optionalXml(zip, rel.target);
        if (notes) slide.notes = notesText(notes);
      }
    }

    for (const blip of doc.getElementsByTagNameNS(NS.a, 'blip')) {
      const rel = rels.get(blip.getAttributeNS(NS.r, 'embed'));
      if (!rel || seen.has(rel.target)) continue;
      seen.add(rel.target);
      if (!PICTURE.test(rel.target) || pictures >= options.maxPictures) {
        skipped += 1;
        continue;
      }
      try {
        const bytes = await zip.bytes(rel.target);
        if (!bytes) throw new Error('missing picture');
        const extension = rel.target.split('.').pop().toLowerCase();
        const jpeg = await toJpeg(new Blob([bytes], { type: MIME[extension] || '' }), options.maxEdge);
        if (Math.max(jpeg.sourceWidth, jpeg.sourceHeight) < options.minPicture) continue; // bullets and tiny icons
        pictures += 1;
        slide.images.push({ blob: jpeg.blob, width: jpeg.width, height: jpeg.height, name: rel.target.split('/').pop() });
      } catch {
        skipped += 1;
      }
    }
    slides.push(slide);
  }
  return { slides, pictures, skipped };
}

function placeholderType(shape) {
  const placeholder = shape && shape.getElementsByTagNameNS ? shape.getElementsByTagNameNS(NS.p, 'ph')[0] : null;
  return placeholder ? placeholder.getAttribute('type') || 'body' : '';
}

function paragraphsOf(container) {
  const out = [];
  for (const paragraph of container.getElementsByTagNameNS(NS.a, 'p')) {
    const text = [...paragraph.getElementsByTagNameNS(NS.a, 't')].map((t) => t.textContent).join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const props = paragraph.getElementsByTagNameNS(NS.a, 'pPr')[0];
    out.push({ text, level: Math.min(Number(props && props.getAttribute('lvl')) || 0, 4) });
  }
  return out;
}

function tableLines(table) {
  const rows = [...table.getElementsByTagNameNS(NS.a, 'tr')].map((row) => [...row.getElementsByTagNameNS(NS.a, 'tc')]
    .map((cell) => paragraphsOf(cell).map((p) => p.text).join(' / ').replace(/\|/g, '/')));
  if (!rows.length) return [];
  const width = Math.max(...rows.map((row) => row.length));
  const line = (cells) => `| ${Array.from({ length: width }, (_, k) => cells[k] || '').join(' | ')} |`;
  return ['Table:', line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)];
}

function chartLines(doc) {
  const values = (element) => (element ? [...element.getElementsByTagNameNS(NS.c, 'v')].map((v) => v.textContent.trim()) : []);
  const title = doc.getElementsByTagNameNS(NS.c, 'title')[0];
  const titleText = title ? paragraphsOf(title).map((p) => p.text).join(' ') : '';
  const series = [...doc.getElementsByTagNameNS(NS.c, 'ser')].map((ser) => {
    const name = values(ser.getElementsByTagNameNS(NS.c, 'tx')[0]).join(' ');
    const categories = values(ser.getElementsByTagNameNS(NS.c, 'cat')[0] || ser.getElementsByTagNameNS(NS.c, 'xVal')[0]);
    const numbers = values(ser.getElementsByTagNameNS(NS.c, 'val')[0] || ser.getElementsByTagNameNS(NS.c, 'yVal')[0]);
    const pairs = numbers.map((value, k) => (categories[k] ? `${categories[k]} = ${value}` : value));
    return `${name ? `${name}: ` : ''}${pairs.join(', ')}`;
  });
  if (!titleText && !series.length) return [];
  return [`Chart${titleText ? ` "${titleText}"` : ''}: ${series.join('; ')}`];
}

function notesText(doc) {
  const out = [];
  for (const body of doc.getElementsByTagNameNS(NS.p, 'txBody')) {
    const type = placeholderType(body.parentNode);
    if (type && type !== 'body') continue;
    out.push(...paragraphsOf(body).map((p) => p.text));
  }
  return out.join(' ');
}

async function relationships(zip, part) {
  const map = new Map();
  const slash = part.lastIndexOf('/');
  const text = await zip.text(`${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`);
  if (!text) return map;
  for (const rel of parseXml(text).getElementsByTagNameNS('*', 'Relationship')) {
    if (rel.getAttribute('TargetMode') === 'External') continue;
    map.set(rel.getAttribute('Id'), { type: rel.getAttribute('Type') || '', target: resolvePath(part, rel.getAttribute('Target') || '') });
  }
  return map;
}

function resolvePath(from, target) {
  if (target.startsWith('/')) return target.slice(1);
  const path = from.split('/').slice(0, -1);
  for (const piece of target.split('/')) {
    if (piece === '..') path.pop();
    else if (piece && piece !== '.') path.push(piece);
  }
  return path.join('/');
}

function parseXml(text) {
  if (!text) throw new Error('missing part');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('bad XML');
  return doc;
}

async function optionalXml(zip, path) {
  try {
    return parseXml(await zip.text(path));
  } catch {
    return null;
  }
}

// Just enough of the zip format for Office files: read the central directory, then inflate entries.
function openZip(buffer) {
  const view = new DataView(buffer);
  let end = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65558); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip');
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const entries = new Map();
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('bad zip directory');
    const nameLength = view.getUint16(offset + 28, true);
    entries.set(decoder.decode(new Uint8Array(buffer, offset + 46, nameLength)), {
      method: view.getUint16(offset + 10, true),
      size: view.getUint32(offset + 20, true),
      local: view.getUint32(offset + 42, true),
    });
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  const bytes = async (path) => {
    const entry = entries.get(path);
    if (!entry || path.endsWith('/')) return null;
    const start = entry.local + 30 + view.getUint16(entry.local + 26, true) + view.getUint16(entry.local + 28, true);
    const data = new Uint8Array(buffer, start, entry.size);
    if (entry.method === 0) return data;
    if (entry.method !== 8) throw new Error('unsupported compression');
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  return {
    bytes,
    async text(path) {
      const data = await bytes(path);
      return data ? decoder.decode(data) : null;
    },
  };
}
