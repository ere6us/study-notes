import { renderMarkdown } from './markdown.js';

// Pinned stable free-tier Flash model; the -latest alias is only a fallback if Google retires it.
const MODELS = ['gemini-3.8-flash', 'gemini-flash-latest'];
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const SKILL_URL = 'skills/handbook/SKILL.md';
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const KEY_ITEM = 'handbook.geminiKey';
const LAST_ITEM = 'handbook.last';

const $ = (id) => document.getElementById(id);
const ui = {
  changeKey: $('change-key'),
  setup: $('setup'),
  keyForm: $('key-form'),
  keyInput: $('key-input'),
  cancelKey: $('cancel-key'),
  forgetKey: $('forget-key'),
  pick: $('pick'),
  fileInput: $('file-input'),
  problem: $('problem'),
  problemText: $('problem-text'),
  retry: $('retry'),
  working: $('working'),
  statusText: $('status-text'),
  timer: $('timer'),
  stop: $('stop'),
  result: $('result'),
  resultNote: $('result-note'),
  handbook: $('handbook'),
  actions: $('actions'),
  savePdf: $('save-pdf'),
  copy: $('copy'),
  printHint: $('print-hint'),
};

const storage = {
  get(name) {
    try { return localStorage.getItem(name); } catch { return null; }
  },
  set(name, value) {
    try { localStorage.setItem(name, value); } catch { /* storage full or blocked */ }
  },
  remove(name) {
    try { localStorage.removeItem(name); } catch { /* ignore */ }
  },
};

class Friendly extends Error {
  constructor(message, retry = false) {
    super(message);
    this.retry = retry;
  }
}

class ApiError extends Error {
  constructor(status, info) {
    super((info && info.message) || `HTTP ${status}`);
    this.status = Number(status) || 0;
    this.details = (info && info.details) || [];
  }

  static async from(response) {
    let info = null;
    try {
      const body = await response.json();
      info = (Array.isArray(body) ? body[0] : body).error;
    } catch { /* not JSON */ }
    return new ApiError(response.status, info);
  }
}

let current = null; // the handbook on screen: { name, md, note }
let lastFile = null; // the PDF of the latest attempt, for "Try again"
let job = null; // the conversion in progress
let wakeLock = null;

function show(view) {
  const hasKey = Boolean(storage.get(KEY_ITEM));
  ui.setup.hidden = view !== 'setup';
  ui.pick.hidden = view !== 'pick';
  ui.working.hidden = view !== 'working';
  ui.changeKey.hidden = !(hasKey && view === 'pick');
  ui.cancelKey.hidden = !(hasKey && view === 'setup');
  ui.forgetKey.hidden = ui.cancelKey.hidden;
  ui.result.hidden = !(view === 'pick' && current);
  ui.actions.hidden = view !== 'pick';
}

function display(handbook) {
  ui.handbook.replaceChildren(renderMarkdown(handbook.md));
  ui.resultNote.textContent = handbook.note || '';
  ui.resultNote.hidden = !handbook.note;
  ui.printHint.hidden = true;
  document.title = `Handbook - ${handbook.name.replace(/\.pdf$/i, '')}`;
}

function showProblem(message, canRetry) {
  ui.problemText.textContent = message;
  ui.retry.hidden = !canRetry;
  ui.problem.hidden = false;
  ui.problem.scrollIntoView({ block: 'center' });
}

function formatSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function checkFile(file) {
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
    return `${file.name} isn't a PDF. Export slides or documents as PDF first (in PowerPoint or Keynote, use Export and choose PDF).`;
  }
  if (file.size === 0) return `${file.name} is empty. Choose another PDF.`;
  if (file.size > MAX_PDF_BYTES) {
    return `${file.name} is ${formatSize(file.size)}. Gemini takes PDFs up to 50 MB, so split it into smaller parts (for example, one chapter each) and make a handbook for each part.`;
  }
  return '';
}

async function loadSkill() {
  const response = await fetch(SKILL_URL, { cache: 'no-cache' });
  if (!response.ok) throw new Friendly("Couldn't load the handbook instructions. Check your internet connection, then tap Try again.", true);
  const text = (await response.text()).replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '').trim();
  if (!text) throw new Friendly('The handbook instructions are empty. Ask the site owner to fix skills/handbook/SKILL.md.');
  return text;
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Friendly(`Couldn't open ${file.name}. If it's stored in iCloud, wait for it to download, then try again.`, true));
    reader.readAsDataURL(file);
  });
}

async function streamHandbook(model, request, progress) {
  const response = await fetch(`${API_BASE}${model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': request.key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: request.skill }] },
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'application/pdf', data: request.pdf } },
          { text: `Make my study handbook from this PDF: ${request.fileName}` },
        ],
      }],
      // Streaming thought summaries keeps the connection busy while the model plans.
      generationConfig: { thinkingConfig: { includeThoughts: true } },
    }),
    signal: request.signal,
  });
  if (!response.ok) throw await ApiError.from(response);
  progress.stage('reading');

  let finishReason = '';
  const handle = (data) => {
    let chunk;
    try { chunk = JSON.parse(data); } catch { return; }
    if (chunk.error) throw new ApiError(chunk.error.code, chunk.error);
    if (chunk.promptFeedback && chunk.promptFeedback.blockReason) finishReason = chunk.promptFeedback.blockReason;
    const candidate = chunk.candidates && chunk.candidates[0];
    if (!candidate) return;
    for (const part of (candidate.content && candidate.content.parts) || []) {
      if (typeof part.text !== 'string' || !part.text) continue;
      if (part.thought) progress.stage('thinking');
      else progress.text(part.text);
    }
    if (candidate.finishReason) finishReason = candidate.finishReason;
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(0), { stream: !done });
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith('data:')) handle(line.slice(5).trim());
    }
    if (done) break;
  }
  if (buffer.trim().startsWith('data:')) handle(buffer.trim().slice(5).trim());
  return finishReason;
}

async function generate(request, progress) {
  let lastError = null;
  for (const model of MODELS) {
    try {
      return await streamHandbook(model, request, progress);
    } catch (error) {
      const modelGone = error instanceof ApiError
        && (error.status === 404 || (error.status === 429 && /limit:\s*0\b/.test(error.message)));
      if (!modelGone || progress.gotText) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

async function start(file) {
  ui.problem.hidden = true;
  const invalid = checkFile(file);
  if (invalid) {
    showProblem(invalid, false);
    return;
  }
  const key = storage.get(KEY_ITEM);
  if (!key) {
    show('setup');
    return;
  }
  lastFile = file;
  const controller = new AbortController();
  job = { controller, started: Date.now(), timer: 0 };
  show('working');
  ui.statusText.textContent = `Sending ${file.name} (${formatSize(file.size)})…`;
  tick();
  job.timer = setInterval(tick, 1000);
  keepAwake();

  let md = '';
  let paintTimer = 0;
  const paint = () => {
    paintTimer = 0;
    ui.handbook.replaceChildren(renderMarkdown(md));
  };
  const progress = {
    gotText: false,
    stage(name) {
      if (progress.gotText) return;
      ui.statusText.textContent = name === 'thinking' ? 'Planning your handbook…' : 'Reading your notes…';
    },
    text(chunk) {
      if (!progress.gotText) {
        progress.gotText = true;
        ui.statusText.textContent = 'Writing your handbook…';
        ui.handbook.replaceChildren();
        ui.resultNote.hidden = true;
        ui.printHint.hidden = true;
        ui.actions.hidden = true;
        ui.result.hidden = false;
      }
      md += chunk;
      if (!paintTimer) paintTimer = setTimeout(paint, 200);
    },
  };

  try {
    const [skill, pdf] = await Promise.all([loadSkill(), readAsBase64(file)]);
    const finishReason = await generate({ key, skill, pdf, fileName: file.name, signal: controller.signal }, progress);
    clearTimeout(paintTimer);
    finish(file, md, finishReason);
  } catch (error) {
    clearTimeout(paintTimer);
    fail(error);
  } finally {
    clearInterval(job.timer);
    job = null;
    releaseWakeLock();
  }
}

function finish(file, md, finishReason) {
  const text = md.trim();
  if (/^NO_CONTENT_FOUND/i.test(text)) {
    const reason = text.replace(/^NO_CONTENT_FOUND:?\s*/i, '').split('\n')[0].trim();
    fail(new Friendly(`Gemini found no study content in ${file.name}${reason ? ` (${reason})` : ''}. If it's a scan, make sure the pages are clear and the right way up.`));
    return;
  }
  if (!text) {
    fail(new Friendly(finishReason && finishReason !== 'STOP'
      ? `Gemini stopped without writing anything (reason: ${finishReason}). Try again, or try a different PDF.`
      : 'Gemini sent back an empty answer. Tap Try again.', true));
    return;
  }
  let note = '';
  if (finishReason === 'MAX_TOKENS') {
    note = 'This handbook stops early because the notes are very long. To cover everything, split the PDF into smaller parts and make a handbook for each part.';
  } else if (finishReason && finishReason !== 'STOP') {
    note = `Gemini stopped before the end (reason: ${finishReason}), so this handbook may be incomplete. Choose the PDF again to retry.`;
  }
  current = { name: file.name, md: text, note };
  storage.set(LAST_ITEM, JSON.stringify(current));
  display(current);
  show('pick');
}

function fail(error) {
  const { message, retry } = explain(error);
  if (current) display(current);
  else ui.handbook.replaceChildren();
  show('pick');
  showProblem(message, Boolean(retry && lastFile));
}

function explain(error) {
  if (error instanceof Friendly) return error;
  if (error && error.name === 'AbortError') return { message: 'Stopped. Choose a PDF to start again.', retry: true };
  if (!(error instanceof ApiError)) {
    return { message: "Couldn't reach Gemini. Check your internet connection and keep this screen open while it works, then tap Try again.", retry: true };
  }
  const { status } = error;
  const everything = `${error.message} ${JSON.stringify(error.details)}`;
  if (/API_KEY_INVALID|API_KEY_EXPIRED|API key (?:not valid|expired|invalid)/i.test(everything)) {
    return { message: "Google didn't accept your API key. Tap Change key at the top and paste the key again from Google AI Studio (it usually starts with AIza)." };
  }
  if (status === 429) {
    if (/PerDay/i.test(everything)) {
      return { message: `You've used up today's free Gemini requests. They reset at ${quotaResetTime()}. Try again after that.` };
    }
    return {
      message: `Gemini's free tier only allows a few requests per minute. Wait ${retryDelay(error.details)}, then tap Try again. If this keeps happening with this PDF, split it into smaller PDFs.`,
      retry: true,
    };
  }
  if (status === 413 || /payload size|too large/i.test(everything)) {
    return { message: 'This PDF is too big for Gemini. Split it into smaller parts (for example, one chapter each) and make a handbook for each part.' };
  }
  if (/location is not supported/i.test(everything)) {
    return { message: "Gemini's free API isn't available in your country or region." };
  }
  if (status === 401 || status === 403) {
    return { message: `Google refused this API key (${error.message}). Tap Change key at the top to use a different key.` };
  }
  if (status === 404) {
    return { message: "The AI model this site uses isn't available any more. Ask the site owner to update the model name in app.js." };
  }
  if (status >= 500) {
    return { message: 'Gemini is busy or took too long. Wait a minute, then tap Try again.', retry: true };
  }
  if (status === 400) {
    return { message: `Gemini couldn't use this PDF: ${error.message} If the PDF has a password, remove it first.` };
  }
  return { message: `Gemini returned an error (${status}): ${error.message}`, retry: true };
}

function retryDelay(details) {
  const info = (details || []).find((item) => item && item.retryDelay);
  const seconds = info ? Math.ceil(parseFloat(info.retryDelay)) : 0;
  return seconds > 0 ? `${seconds} seconds` : 'a minute';
}

// Daily quotas reset at midnight Pacific time; show that moment in the student's own time zone.
function quotaResetTime() {
  try {
    const hourInCalifornia = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' });
    let time = Math.ceil(Date.now() / 3600000) * 3600000;
    for (let i = 0; i < 26; i += 1, time += 3600000) {
      if (Number(hourInCalifornia.format(time)) === 0) {
        return `${new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} your time (midnight in California)`;
      }
    }
  } catch { /* fall through */ }
  return 'midnight Pacific time';
}

function tick() {
  const seconds = Math.floor((Date.now() - job.started) / 1000);
  ui.timer.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// Keep the screen on while Gemini works (Safari 16.4+); harmless where unsupported.
async function keepAwake() {
  if (!navigator.wakeLock || document.hidden || wakeLock) return;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (!job) {
      lock.release();
      return;
    }
    wakeLock = lock;
    lock.addEventListener('release', () => {
      if (wakeLock === lock) wakeLock = null;
    });
  } catch { /* not allowed right now */ }
}

function releaseWakeLock() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (job && !document.hidden) keepAwake();
});

ui.keyForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const key = ui.keyInput.value.trim();
  if (!key) return;
  storage.set(KEY_ITEM, key);
  ui.keyInput.value = '';
  ui.problem.hidden = true;
  show('pick');
});

ui.changeKey.addEventListener('click', () => show('setup'));
ui.cancelKey.addEventListener('click', () => show('pick'));
ui.forgetKey.addEventListener('click', () => {
  storage.remove(KEY_ITEM);
  show('setup');
});

ui.fileInput.addEventListener('change', () => {
  const file = ui.fileInput.files && ui.fileInput.files[0];
  ui.fileInput.value = '';
  if (file) start(file);
});

ui.retry.addEventListener('click', () => {
  if (lastFile) start(lastFile);
});

ui.stop.addEventListener('click', () => {
  if (job) job.controller.abort();
});

ui.savePdf.addEventListener('click', () => {
  // Home Screen web apps on iOS can't print; if no print screen opens, explain the way around it.
  let opened = false;
  const mark = () => { opened = true; };
  window.addEventListener('beforeprint', mark, { once: true });
  ui.printHint.hidden = true;
  window.print();
  setTimeout(() => {
    window.removeEventListener('beforeprint', mark);
    if (!opened) ui.printHint.hidden = false;
  }, 2500);
});

ui.copy.addEventListener('click', async () => {
  if (!current) return;
  try {
    if (window.ClipboardItem && navigator.clipboard.write) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([current.md], { type: 'text/plain' }),
        'text/html': new Blob([ui.handbook.innerHTML], { type: 'text/html' }),
      })]);
    } else {
      await navigator.clipboard.writeText(current.md);
    }
    ui.copy.textContent = 'Copied';
  } catch {
    ui.copy.textContent = "Couldn't copy";
  }
  setTimeout(() => { ui.copy.textContent = 'Copy text'; }, 2000);
});

try {
  const saved = JSON.parse(storage.get(LAST_ITEM) || 'null');
  if (saved && typeof saved.md === 'string' && saved.md.trim()) {
    current = { name: String(saved.name || 'notes.pdf'), md: saved.md, note: String(saved.note || '') };
    display(current);
  }
} catch { /* ignore a damaged saved handbook */ }
show(storage.get(KEY_ITEM) ? 'pick' : 'setup');
