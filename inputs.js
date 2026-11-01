import { Problem } from './errors.js';
import { toJpeg } from './images.js';
import { readPptx } from './pptx.js';

// Turns what the student picked (one PDF, one PowerPoint file, or photos) into request parts:
// { text } or { blob, mimeType, name }. gemini.js decides whether each blob goes inline or is uploaded.

export const MAX_PDF_BYTES = 50 * 1024 * 1024;
export const MAX_SLIDES_BYTES = 200 * 1024 * 1024;
export const MAX_PHOTOS = 30;
const PHOTO_EDGE = 2048;
const SLIDE_PICTURE_EDGE = 1600;
const PPTX_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export function formatSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function kindOf(file) {
  const name = (file.name || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  if (type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (type === PPTX_TYPE || name.endsWith('.pptx')) return 'pptx';
  if (type === 'application/vnd.ms-powerpoint' || /\.(ppt|pps|pot)$/.test(name)) return 'ppt';
  if (name.endsWith('.key') || type.includes('keynote')) return 'keynote';
  if (name.endsWith('.gslides') || type.includes('google-apps.presentation')) return 'gslides';
  if (type.startsWith('image/') || /\.(jpe?g|png|heic|heif|webp|gif|bmp|tiff?)$/.test(name)) return 'image';
  return 'other';
}

// onStage(name, info) reports progress: 'slides' { n, total } or 'photos' { n, total }.
export async function readInput(files, onStage = () => {}) {
  const list = [...files];
  if (!list.length) throw new Problem('UNSUPPORTED', { name: 'That file' });
  const kinds = list.map(kindOf);
  if (list.length > 1 || kinds[0] === 'image') {
    if (kinds.some((kind) => kind !== 'image')) throw new Problem('MIXED_FILES');
    if (list.length > MAX_PHOTOS) throw new Problem('TOO_MANY_PHOTOS', { count: list.length, max: MAX_PHOTOS });
    return readPhotos(list, onStage);
  }
  const [file] = list;
  const name = file.name;
  switch (kinds[0]) {
    case 'pdf': return readPdf(file);
    case 'pptx': return readSlides(file, onStage);
    case 'ppt': throw new Problem('OLD_PPT', { name });
    case 'keynote': throw new Problem('KEYNOTE', { name });
    case 'gslides': throw new Problem('GOOGLE_SLIDES', { name });
    default: throw new Problem('UNSUPPORTED', { name });
  }
}

async function readPdf(file) {
  const name = file.name;
  if (file.size > MAX_PDF_BYTES) throw new Problem('TOO_BIG', { name, size: formatSize(file.size), limit: '50 MB' });
  let start = '';
  try {
    start = file.size ? await file.slice(0, 1024).text() : '';
  } catch {
    throw new Problem('FILE_UNREADABLE', { name });
  }
  if (!start.includes('%PDF')) throw new Problem('FILE_UNREADABLE', { name });
  return { kind: 'pdf', label: name, parts: [{ blob: file, mimeType: 'application/pdf', name }] };
}

async function readSlides(file, onStage) {
  if (file.size > MAX_SLIDES_BYTES) throw new Problem('TOO_BIG', { name: file.name, size: formatSize(file.size), limit: '200 MB' });
  onStage('slides', {});
  const { slides } = await readPptx(file, {
    maxEdge: SLIDE_PICTURE_EDGE,
    onSlide: (n, total) => onStage('slides', { n, total }),
  });
  const readable = slides.some((slide) => slide.title || slide.lines.length || slide.notes || slide.images.length);
  if (!readable) throw new Problem('SLIDES_EMPTY', { name: file.name });
  const parts = [];
  for (const slide of slides) {
    const lines = [`Slide ${slide.number} of ${slides.length}${slide.title ? `: ${slide.title}` : ''}`, ...slide.lines];
    if (slide.notes) lines.push(`Speaker notes: ${slide.notes}`);
    if (slide.images.length) lines.push(`(${slide.images.length === 1 ? 'Its picture follows' : `Its ${slide.images.length} pictures follow`}.)`);
    parts.push({ text: lines.join('\n') });
    for (const image of slide.images) parts.push({ blob: image.blob, mimeType: 'image/jpeg', name: image.name });
  }
  const count = slides.length === 1 ? '1 slide' : `${slides.length} slides`;
  return { kind: 'slides', label: `${file.name} (${count})`, parts };
}

async function readPhotos(files, onStage) {
  const parts = [];
  for (let i = 0; i < files.length; i += 1) {
    onStage('photos', { n: i + 1, total: files.length });
    let jpeg;
    try {
      jpeg = await toJpeg(files[i], PHOTO_EDGE);
    } catch {
      throw new Problem('PHOTO_UNREADABLE', { name: files[i].name || 'A photo' });
    }
    parts.push({ text: `Photo ${i + 1} of ${files.length}:` });
    parts.push({ blob: jpeg.blob, mimeType: 'image/jpeg', name: `photo-${i + 1}.jpg` });
  }
  return { kind: 'photos', label: files.length === 1 ? '1 photo' : `${files.length} photos`, parts };
}
