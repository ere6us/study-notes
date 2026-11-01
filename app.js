import { renderMarkdown } from './markdown.js';
import { Problem, classify, describe } from './errors.js';
import { readInput } from './inputs.js';
import { MODELS, forgetUploads, generate, prepareParts } from './gemini.js';

const SKILLS = { handbook: 'skills/handbook/SKILL.md', explain: 'skills/explain/SKILL.md' };
const FRONTMATTER = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const KEY_ITEM = 'handbook.geminiKey';
const LAST_ITEM = 'handbook.last';
const MODE_ITEM = 'handbook.mode';
const BACKUP_LINES = {
  day: "Made with Google's backup model because today's main free limit is used up.",
  'no-quota': "Made with Google's backup model because the main one has no free allowance on this key.",
  gone: "Made with Google's backup model because the main one isn't available any more.",
};
const WORDS = {
  handbook: { thing: 'handbook', title: 'Handbook' },
  explain: { thing: 'explanation', title: 'Explained' },
};
// Both buttons open the iPhone print screen, which turns the page into a PDF; its Share icon does the rest.
const PRINT_TIPS = {
  save: 'On the print screen, tap the Share icon at the top, then Save to Files.',
  share: 'On the print screen, tap the Share icon at the top, then pick WhatsApp, Mail, AirDrop or another app.',
};

const $ = (id) => document.getElementById(id);
const ui = {
  changeKey: $('change-key'),
  setup: $('setup'),
  keyForm: $('key-form'),
  keyInput: $('key-input'),
  cancelKey: $('cancel-key'),
  forgetKey: $('forget-key'),
  pick: $('pick'),
  docInput: $('doc-input'),
  photoInput: $('photo-input'),
  problem: $('problem'),
  problemTitle: $('problem-title'),
  problemBody: $('problem-body'),
  problemCode: $('problem-code'),
  retry: $('retry'),
  fixKey: $('fix-key'),
  working: $('working'),
  statusText: $('status-text'),
  timer: $('timer'),
  stop: $('stop'),
  result: $('result'),
  resultNote: $('result-note'),
  handbook: $('handbook'),
  actions: $('actions'),
  savePdf: $('save-pdf'),
  share: $('share'),
  tip: $('print-tip'),
  notice: $('notice'),
};

const storage = {
  get(name) {
    try { return localStorage.getItem(name); } catch { return null; }
  },
  set(name, value) {
    try {
      localStorage.setItem(name, value);
      return true;
    } catch {
      return false;
    }
  },
  remove(name) {
    try { localStorage.removeItem(name); } catch { /* ignore */ }
  },
};

let sessionKey = ''; // used for this visit only when the browser won't store the key
let current = null; // the handbook on screen: { name, md, mode, notes, backup }
let lastFiles = null; // the files of the latest attempt, for "Try again"
let job = null; // the work in progress
let wakeLock = null;
let countdown = 0;

const getKey = () => storage.get(KEY_ITEM) || sessionKey;
const getMode = () => (document.querySelector('input[name="mode"]:checked') || {}).value === 'explain' ? 'explain' : 'handbook';

function show(view) {
  const hasKey = Boolean(getKey());
  ui.setup.hidden = view !== 'setup';
  ui.pick.hidden = view !== 'pick';
  ui.working.hidden = view !== 'working';
  ui.changeKey.hidden = !(hasKey && view === 'pick');
  ui.cancelKey.hidden = !(hasKey && view === 'setup');
  ui.forgetKey.hidden = ui.cancelKey.hidden;
  ui.result.hidden = !(view === 'pick' && current);
  ui.actions.hidden = view !== 'pick';
}

function noticeNodes(problem) {
  const info = describe(problem);
  const title = document.createElement('p');
  title.className = 'notice-title';
  title.textContent = info.title;
  const body = document.createElement('p');
  body.textContent = info.body;
  const code = document.createElement('p');
  code.className = 'code';
  code.textContent = `Code: ${info.code}`;
  return [title, body, code];
}

function display(handbook) {
  ui.handbook.replaceChildren(renderMarkdown(handbook.md));
  const notes = [];
  if (handbook.backup) {
    const line = document.createElement('p');
    line.className = 'backup-line';
    line.textContent = BACKUP_LINES[handbook.backup] || BACKUP_LINES.day;
    notes.push(line);
  }
  for (const code of handbook.notes || []) {
    const box = document.createElement('div');
    box.className = 'note-item';
    box.append(...noticeNodes(new Problem(code)));
    notes.push(box);
  }
  ui.resultNote.replaceChildren(...notes);
  ui.resultNote.hidden = !notes.length;
  ui.notice.hidden = true;
  ui.tip.hidden = true;
  const words = WORDS[handbook.mode] || WORDS.handbook;
  document.title = `${words.title} - ${handbook.name.replace(/\.(pdf|pptx)$/i, '')}`;
}

// Bring the new result into view once when it first appears; after that, never chase the stream.
function revealResult() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  ui.result.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

// When the pickers come back above a finished result, keep her reading place (or reveal the result
// if it arrived all at once). A problem message, which scrolls itself into view, takes priority.
function placeResult(before) {
  if (ui.result.hidden || !ui.problem.hidden) return;
  if (before === null) revealResult();
  else window.scrollBy(0, ui.handbook.getBoundingClientRect().top - before);
}

function showProblem(problem) {
  const info = describe(problem);
  ui.problemTitle.textContent = info.title;
  ui.problemBody.textContent = info.body;
  ui.problemCode.textContent = `Code: ${info.code}`;
  stopCountdown();
  const canRetry = Boolean(lastFiles) && (info.action === 'retry' || info.action === 'wait');
  ui.retry.hidden = !canRetry;
  ui.fixKey.hidden = info.action !== 'key';
  if (info.action === 'wait' && canRetry) startCountdown(problem.vars.wait || 60);
  ui.problem.hidden = false;
  ui.problem.scrollIntoView({ block: 'center' });
}

function hideProblem() {
  stopCountdown();
  ui.problem.hidden = true;
}

function startCountdown(seconds) {
  let left = Math.max(1, Math.round(seconds));
  const render = () => {
    ui.retry.disabled = left > 0;
    ui.retry.textContent = left > 0 ? `Try again in ${left >= 60 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : `${left} s`}` : 'Try again';
  };
  render();
  countdown = setInterval(() => {
    left -= 1;
    render();
    if (left <= 0) {
      clearInterval(countdown);
      countdown = 0;
    }
  }, 1000);
}

function stopCountdown() {
  clearInterval(countdown);
  countdown = 0;
  ui.retry.disabled = false;
  ui.retry.textContent = 'Try again';
}

function setStatus(text) {
  ui.statusText.textContent = text;
}

function promptFor(input, mode) {
  const what = {
    pdf: `this PDF (${input.label})`,
    slides: `these slides (${input.label}). Each slide's text, tables, chart data, SmartArt and speaker notes come first, followed by its pictures`,
    photos: `these photos of notes, textbook pages or diagrams (${input.label}), in order`,
  }[input.kind];
  return mode === 'explain' ? `Explain ${what} simply, so I can understand it.` : `Make my study handbook from ${what}.`;
}

async function loadSkill(mode) {
  let response;
  try {
    response = await fetch(SKILLS[mode], { cache: 'no-cache' });
  } catch {
    throw new Problem('SKILL_MISSING');
  }
  if (!response.ok) throw new Problem('SKILL_MISSING');
  const text = (await response.text()).replace(FRONTMATTER, '').trim();
  if (!text) throw new Problem('SKILL_MISSING');
  return text;
}

async function start(files) {
  hideProblem();
  const key = getKey();
  if (!key) {
    show('setup');
    return;
  }
  lastFiles = files;
  const mode = getMode();
  const words = WORDS[mode];
  const controller = new AbortController();
  job = { controller, started: Date.now(), timer: 0, hidden: document.hidden };
  show('working');
  setStatus('Getting your file ready…');
  tick();
  job.timer = setInterval(tick, 1000);
  keepAwake();

  let input = null;
  let md = '';
  let paintTimer = 0;
  const uploaded = [];
  const progress = {
    gotText: false,
    revealed: false,
    stage(name, info = {}) {
      if (progress.gotText) return;
      const text = {
        slides: info.total ? `Reading slide ${info.n} of ${info.total}…` : 'Opening your slides…',
        photos: `Preparing photo ${info.n} of ${info.total}…`,
        upload: info.total > 1 ? `Uploading part ${info.n} of ${info.total} to Google…` : 'Uploading your file to Google…',
        sending: 'Sending to Gemini…',
        reading: 'Gemini is reading…',
        thinking: `Planning your ${words.thing}…`,
      }[name];
      if (text) setStatus(text);
    },
    text(chunk) {
      if (!progress.gotText) {
        progress.gotText = true;
        setStatus(`Writing your ${words.thing}…`);
        ui.handbook.replaceChildren();
        ui.resultNote.hidden = true;
        ui.notice.hidden = true;
        ui.tip.hidden = true;
        ui.actions.hidden = true;
        ui.result.hidden = false;
      }
      md += chunk;
      if (!paintTimer) paintTimer = setTimeout(paint, 200);
    },
  };
  const paint = () => {
    paintTimer = 0;
    ui.handbook.replaceChildren(renderMarkdown(md));
    if (!progress.revealed) {
      progress.revealed = true;
      revealResult();
    }
  };

  try {
    input = await readInput(files, progress.stage);
    if (!navigator.onLine) throw new Problem('OFFLINE');
    const skill = await loadSkill(mode);
    const parts = await prepareParts([...input.parts, { text: promptFor(input, mode) }], {
      key, signal: controller.signal, onStage: progress.stage, uploaded,
    });
    progress.stage('sending');
    const result = await generate({ key, skill, parts, signal: controller.signal }, progress);
    clearTimeout(paintTimer);
    const before = progress.revealed ? ui.handbook.getBoundingClientRect().top : null;
    finish(input, md, result, mode);
    placeResult(before);
  } catch (error) {
    clearTimeout(paintTimer);
    fail(error, { md, mode, input });
  } finally {
    clearInterval(job.timer);
    job = null;
    releaseWakeLock();
    if (uploaded.length) forgetUploads(uploaded, key);
  }
}

function finish(input, md, result, mode) {
  const text = md.trim();
  if (/^NO_CONTENT_FOUND/i.test(text)) {
    const reason = text.replace(/^NO_CONTENT_FOUND:?\s*/i, '').split('\n')[0].trim();
    fail(new Problem('NO_CONTENT', { name: input.label, reason: reason ? ` (${reason})` : '' }));
    return;
  }
  const { finishReason } = result;
  let stopped = null;
  if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY'].includes(finishReason)) stopped = new Problem('BLOCKED');
  else if (finishReason === 'RECITATION') stopped = new Problem('RECITATION');
  else if (finishReason && !['STOP', 'MAX_TOKENS'].includes(finishReason)) stopped = new Problem('UNKNOWN', { detail: finishReason });
  if (!text) {
    fail(stopped || new Problem('EMPTY_ANSWER'));
    return;
  }
  const notes = [];
  if (finishReason === 'MAX_TOKENS') notes.push('CUT_SHORT');
  if (stopped) notes.push('PARTIAL');
  current = { name: input.label, md: text, mode, notes, backup: result.model === MODELS[0] ? '' : result.backup };
  storage.set(LAST_ITEM, JSON.stringify(current));
  display(current);
  show('pick');
  if (stopped) showProblem(stopped);
}

function fail(error, { md = '', mode = getMode(), input = null } = {}) {
  const problem = classify(error, {
    offline: !navigator.onLine,
    hidden: Boolean(job && job.hidden),
    partial: Boolean(md.trim()),
  });
  // Whatever stopped it, keep what was already written so it can still be read and saved.
  if (md.trim()) {
    current = { name: input ? input.label : 'notes', md: md.trim(), mode, notes: ['PARTIAL'], backup: '' };
    storage.set(LAST_ITEM, JSON.stringify(current));
  }
  if (current) display(current);
  else ui.handbook.replaceChildren();
  show('pick');
  showProblem(problem);
}

function tick() {
  if (!job) return;
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

// Save as PDF and Share both open the print screen. Home Screen web apps on iOS can't print, so if
// no print screen opens, the tip is replaced by how to get a PDF anyway.
function printHandbook(kind) {
  let opened = false;
  const mark = () => { opened = true; };
  window.addEventListener('beforeprint', mark, { once: true });
  ui.notice.hidden = true;
  ui.tip.textContent = PRINT_TIPS[kind];
  ui.tip.hidden = false;
  try {
    window.print();
  } catch { /* handled by the check below */ }
  setTimeout(() => {
    window.removeEventListener('beforeprint', mark);
    if (!opened) {
      ui.tip.hidden = true;
      ui.notice.replaceChildren(...noticeNodes(new Problem('PRINT_UNAVAILABLE')));
      ui.notice.hidden = false;
    }
  }, 2500);
}

document.addEventListener('visibilitychange', () => {
  if (!job) return;
  if (document.hidden) job.hidden = true;
  else keepAwake();
});

ui.keyForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const key = ui.keyInput.value.trim();
  if (!key) return;
  ui.keyInput.value = '';
  ui.keyInput.blur();
  const saved = storage.set(KEY_ITEM, key);
  sessionKey = saved ? '' : key;
  show('pick');
  window.scrollTo(0, 0); // start the daily screen at the top, dedication and all
  if (saved) hideProblem();
  else showProblem(new Problem('STORAGE_BLOCKED'));
});

ui.changeKey.addEventListener('click', () => show('setup'));
ui.fixKey.addEventListener('click', () => show('setup'));
ui.cancelKey.addEventListener('click', () => {
  show('pick');
  window.scrollTo(0, 0);
});
ui.forgetKey.addEventListener('click', () => {
  storage.remove(KEY_ITEM);
  sessionKey = '';
  show('setup');
});

for (const picker of [ui.docInput, ui.photoInput]) {
  picker.addEventListener('change', () => {
    const files = [...(picker.files || [])];
    picker.value = '';
    if (files.length) start(files);
  });
}

for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener('change', () => storage.set(MODE_ITEM, getMode()));
}

ui.retry.addEventListener('click', () => {
  if (lastFiles && !ui.retry.disabled) start(lastFiles);
});

ui.stop.addEventListener('click', () => {
  if (job) job.controller.abort();
});

ui.savePdf.addEventListener('click', () => printHandbook('save'));
ui.share.addEventListener('click', () => printHandbook('share'));

if (storage.get(MODE_ITEM) === 'explain') document.querySelector('input[name="mode"][value="explain"]').checked = true;
try {
  const saved = JSON.parse(storage.get(LAST_ITEM) || 'null');
  if (saved && typeof saved.md === 'string' && saved.md.trim()) {
    current = {
      name: String(saved.name || 'notes'),
      md: saved.md,
      mode: saved.mode === 'explain' ? 'explain' : 'handbook',
      notes: Array.isArray(saved.notes) ? saved.notes.filter((code) => typeof code === 'string') : [],
      backup: typeof saved.backup === 'string' ? saved.backup : '',
    };
    display(current);
  }
} catch { /* ignore a damaged saved handbook */ }
show(getKey() ? 'pick' : 'setup');
