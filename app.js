import { renderMarkdown } from './markdown.js';
import { Problem, classify, describe } from './errors.js';
import { readInput } from './inputs.js';
import { ASK_MODELS, MODELS, forgetUploads, generate, prepareParts } from './gemini.js';
import { loadLoveNotes, startLoveNotes } from './love-notes.js';
import { attach, findPassage, fingerprint, normal, ownText, passagesOf, placeOfSelection } from './ask.js';

const SKILLS = {
  handbook: 'skills/handbook/SKILL.md',
  explain: 'skills/explain/SKILL.md',
  ask: 'skills/ask/SKILL.md',
};
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
const READING = 'Gemini is reading your notes…';
// fetch can't report upload progress, so the status moves on from sending to reading after a
// guess: the time the request takes at a cautious 250 KB/s, and at least 15 seconds.
const SEND_SPEED = 250 * 1024;
// The love-notes.md stage that each step of the work takes its lines from.
const LOVE_STAGES = {
  slides: 'getting ready',
  photos: 'getting ready',
  upload: 'sending',
  sending: 'sending',
  reading: 'reading',
  thinking: 'planning',
};
const BLOCKED = ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY'];
const QUOTE_MAX = 500; // characters of the selected words kept with a question
const QUESTION_MAX = 300;

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
  love: $('love'),
  timer: $('timer'),
  stop: $('stop'),
  result: $('result'),
  resultNote: $('result-note'),
  handbook: $('handbook'),
  actions: $('actions'),
  ask: $('ask'),
  askLabel: $('ask-label'),
  savePdf: $('save-pdf'),
  share: $('share'),
  tip: $('print-tip'),
  notice: $('notice'),
  askDialog: $('ask-dialog'),
  askForm: $('ask-form'),
  askQuote: $('ask-quote'),
  askInput: $('ask-input'),
  askSend: $('ask-send'),
  askCancel: $('ask-cancel'),
  chips: [...document.querySelectorAll('#ask-dialog .chip')],
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
let current = null; // the handbook on screen: { name, md, mode, notes, backup, qa }
let lastFiles = null; // the files of the latest attempt, for "Try again"
let job = null; // the work in progress
let wakeLock = null;
let stopRetryCountdown = null;
let picked = null; // the latest selection in the handbook: { quote, passage } or { quote, box }
let held = null; // the selection kept as the Ask button is pressed
let hideAsk = 0; // hides the Ask button a moment after the selection goes
let chosen = null; // what the open ask form is about: { quote, passage, index, fp }
let asking = null; // the question being answered: { controller, box, hidden }
const boxEntries = new WeakMap(); // question box → { quote, question, answer, index, fp, at }
const boxPassages = new WeakMap(); // question box → the passage it sits under (null in "My questions")
const boxCountdowns = new WeakMap(); // question box → stops its Try again countdown

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
  placeQuestions(handbook.qa || []);
  forgetSelection();
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
// Smooth scrolling never runs while the page is hidden (another app, a locked screen), so jump then.
function revealResult() {
  const instant = document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  ui.result.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'start' });
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

// Counts down on a Try again button and enables it at the end. Returns a function that stops it.
function countdown(button, seconds) {
  let left = Math.max(1, Math.round(seconds));
  const render = () => {
    button.disabled = left > 0;
    button.textContent = left > 0 ? `Try again in ${left >= 60 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : `${left} s`}` : 'Try again';
  };
  render();
  const timer = setInterval(() => {
    left -= 1;
    render();
    if (left <= 0) clearInterval(timer);
  }, 1000);
  return () => clearInterval(timer);
}

function startCountdown(seconds) {
  stopCountdown();
  stopRetryCountdown = countdown(ui.retry, seconds);
}

function stopCountdown() {
  if (stopRetryCountdown) stopRetryCountdown();
  stopRetryCountdown = null;
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

// What goes up with the request: inline data (as base64) and text.
const payloadSize = (parts) => parts.reduce((sum, part) => sum + (part.inlineData ? part.inlineData.data.length : (part.text || '').length), 0);

async function loadSkill(name) {
  let response;
  try {
    response = await fetch(SKILLS[name], { cache: 'no-cache' });
  } catch {
    throw new Problem('SKILL_MISSING');
  }
  if (!response.ok) throw new Problem('SKILL_MISSING');
  const text = (await response.text()).replace(FRONTMATTER, '').trim();
  if (!text) throw new Problem('SKILL_MISSING');
  return text;
}

async function start(files) {
  if (asking) asking.controller.abort();
  closeAsk();
  forgetSelection();
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
  const love = startLoveNotes(ui.love, { notes: loadLoveNotes(), thing: words.thing });
  job = { controller, started: Date.now(), timer: 0, hidden: document.hidden, minutes: 0, love };
  show('working');
  setStatus('Getting your file ready…');
  love.use('getting ready');
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
    step: '',
    readingTimer: 0,
    stage(name, info = {}) {
      if (progress.gotText) return;
      progress.step = name;
      const text = {
        slides: info.total ? `Reading slide ${info.n} of ${info.total}…` : 'Opening your slides…',
        photos: `Preparing photo ${info.n} of ${info.total}…`,
        upload: info.total > 1 ? `Uploading part ${info.n} of ${info.total} to Google…` : 'Uploading your file to Google…',
        sending: 'Sending to Gemini…',
        reading: READING,
        thinking: `Planning your ${words.thing}…`,
      }[name];
      if (text) setStatus(text);
      if (LOVE_STAGES[name]) love.use(LOVE_STAGES[name]);
      if (name === 'sending') {
        const wait = info.bytes ? Math.max(15000, (info.bytes / SEND_SPEED) * 1000) : 20000;
        progress.readingTimer = setTimeout(() => {
          if (progress.step === 'sending') progress.stage('reading');
        }, wait);
      }
    },
    text(chunk) {
      if (!progress.gotText) {
        progress.gotText = true;
        setStatus(`Writing your ${words.thing}…`);
        love.use('writing');
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
    progress.stage('sending', { bytes: payloadSize(parts) });
    const result = await generate({ key, skill, parts, signal: controller.signal }, progress);
    clearTimeout(paintTimer);
    const before = progress.revealed ? ui.handbook.getBoundingClientRect().top : null;
    finish(input, md, result, mode);
    placeResult(before);
  } catch (error) {
    clearTimeout(paintTimer);
    fail(error, { md, mode, input });
  } finally {
    clearTimeout(progress.readingTimer);
    clearInterval(job.timer);
    love.stop();
    job = null;
    releaseWakeLock();
    if (uploaded.length) forgetUploads(uploaded, key);
  }
}

// Why Gemini stopped before the end, as a problem to show, or null when it finished normally.
function stopReason(finishReason) {
  if (BLOCKED.includes(finishReason)) return new Problem('BLOCKED');
  if (finishReason === 'RECITATION') return new Problem('RECITATION');
  if (finishReason && !['STOP', 'MAX_TOKENS'].includes(finishReason)) return new Problem('UNKNOWN', { detail: finishReason });
  return null;
}

function finish(input, md, result, mode) {
  const text = md.trim();
  if (/^NO_CONTENT_FOUND/i.test(text)) {
    const reason = text.replace(/^NO_CONTENT_FOUND:?\s*/i, '').split('\n')[0].trim();
    fail(new Problem('NO_CONTENT', { name: input.label, reason: reason ? ` (${reason})` : '' }));
    return;
  }
  const { finishReason } = result;
  const stopped = stopReason(finishReason);
  if (!text) {
    fail(stopped || new Problem('EMPTY_ANSWER'));
    return;
  }
  const notes = [];
  if (finishReason === 'MAX_TOKENS') notes.push('CUT_SHORT');
  if (stopped) notes.push('PARTIAL');
  current = { name: input.label, md: text, mode, notes, backup: result.model === MODELS[0] ? '' : result.backup, qa: [] };
  remember();
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
    current = { name: input ? input.label : 'notes', md: md.trim(), mode, notes: ['PARTIAL'], backup: '', qa: [] };
    remember();
  }
  if (current) display(current);
  else ui.handbook.replaceChildren();
  show('pick');
  showProblem(problem);
}

// Saves the handbook on screen, with its questions, so it's still here next time.
function remember() {
  if (current) storage.set(LAST_ITEM, JSON.stringify(current));
}

function tick() {
  if (!job) return;
  const seconds = Math.floor((Date.now() - job.started) / 1000);
  ui.timer.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  // At every full minute of the run, a "still waiting" love note with the time.
  const minutes = Math.floor(seconds / 60);
  if (minutes > job.minutes) {
    job.minutes = minutes;
    job.love.minute(minutes);
  }
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

// Asking about a passage. She selects words in her handbook (long-press and drag), taps Ask about
// this, and Gemini's answer appears in a box right under that passage. iOS doesn't let a page add
// to its own Copy / Look Up menu, so the button is the page's own, in the bar at the bottom.

function readSelection() {
  if (job || ui.result.hidden || ui.actions.hidden) return null;
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!ui.handbook.contains(range.commonAncestorContainer)) return null;
  const quote = normal(selection.toString()).slice(0, QUOTE_MAX);
  const place = quote ? placeOfSelection(ui.handbook, range) : null;
  return place ? { quote, ...place } : null;
}

function forgetSelection() {
  clearTimeout(hideAsk);
  hideAsk = 0;
  picked = null;
  held = null;
  ui.ask.hidden = true;
}

function openAsk(selection) {
  const entry = selection.box ? boxEntries.get(selection.box) : null;
  if (selection.box && !entry) return;
  const passage = selection.box ? boxPassages.get(selection.box) : selection.passage;
  chosen = {
    quote: selection.quote,
    passage: passage && passage.isConnected ? passage : null,
    index: entry ? entry.index : passagesOf(ui.handbook).indexOf(passage),
    fp: entry ? entry.fp : fingerprint(passage),
  };
  forgetSelection();
  ui.askQuote.textContent = `“${shorten(chosen.quote, 160)}”`;
  ui.askInput.value = '';
  if (!ui.askDialog.open) ui.askDialog.showModal();
}

function closeAsk() {
  chosen = null;
  if (ui.askDialog.open) ui.askDialog.close();
}

function sendQuestion(text) {
  if (!chosen || asking || !current) return;
  const question = normal(text).slice(0, QUESTION_MAX);
  if (!question) {
    ui.askInput.focus();
    return;
  }
  const about = chosen;
  closeAsk();
  const selection = document.getSelection();
  if (selection) selection.removeAllRanges();
  forgetSelection();
  const entry = { quote: about.quote, question, answer: '', index: about.index, fp: about.fp, at: Date.now() };
  const box = questionBox(entry, about.passage);
  attach(ui.handbook, box, about.passage);
  const instant = document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  box.scrollIntoView({ block: 'nearest', behavior: instant ? 'auto' : 'smooth' });
  answerQuestion(box, current);
}

// A pink "You asked" box: her selected words, her question (as plain text) and the answer.
function questionBox(entry, passage) {
  const box = document.createElement('div');
  box.className = 'qa';
  box.setAttribute('role', 'note');
  box.dataset.state = entry.answer ? 'done' : 'asking';
  const remove = makeButton('qa-remove', '×');
  remove.setAttribute('aria-label', 'Remove this question');
  remove.addEventListener('click', () => removeQuestion(box));
  box.append(remove);
  if (entry.quote) box.append(paragraph('qa-quote', `“${shorten(entry.quote, 80)}”`));
  box.append(paragraph('qa-question', `You asked: ${entry.question}`));
  const answer = document.createElement('div');
  answer.className = 'qa-answer';
  if (entry.answer) answer.append(renderMarkdown(entry.answer));
  box.append(answer);
  boxEntries.set(box, entry);
  boxPassages.set(box, passage);
  return box;
}

// Puts saved questions back under their passages when a handbook is shown.
function placeQuestions(entries) {
  if (!entries.length) return;
  const passages = passagesOf(ui.handbook);
  const texts = passages.map((passage) => normal(ownText(passage)));
  for (const entry of entries) {
    const passage = findPassage(passages, texts, entry);
    attach(ui.handbook, questionBox(entry, passage), passage);
  }
}

// Her question, with the whole handbook for context and the words she selected. Only text is sent,
// never the original file, so answers come back in seconds.
function askPrompt(md, entry) {
  return [
    'My handbook:',
    '<handbook>',
    md,
    '</handbook>',
    '',
    'The passage I selected:',
    '<passage>',
    entry.quote,
    '</passage>',
    '',
    `My question: ${entry.question}`,
  ].join('\n');
}

async function answerQuestion(box, target) {
  const entry = boxEntries.get(box);
  const key = getKey();
  if (!entry || asking || !key) return;
  const controller = new AbortController();
  asking = { controller, box, hidden: document.hidden };
  setAsking(true);
  stopBoxCountdown(box);
  for (const old of box.querySelectorAll('.qa-problem, .qa-wait')) old.remove();
  const answer = box.querySelector('.qa-answer');
  answer.replaceChildren();
  box.dataset.state = 'asking';

  const wait = document.createElement('div');
  wait.className = 'qa-wait';
  const status = paragraph('qa-wait-title', 'Gemini is answering…');
  status.setAttribute('role', 'status');
  const line = document.createElement('div');
  line.className = 'love';
  line.setAttribute('aria-hidden', 'true');
  wait.append(status, line);
  box.append(wait);
  const love = startLoveNotes(line, { notes: loadLoveNotes(), thing: (WORDS[target.mode] || WORDS.handbook).thing });
  love.use('answering');

  let md = '';
  let paintTimer = 0;
  const paint = () => {
    clearTimeout(paintTimer);
    paintTimer = 0;
    answer.replaceChildren(renderMarkdown(md));
  };
  const progress = {
    gotText: false,
    stage() {},
    text(chunk) {
      if (!progress.gotText) {
        progress.gotText = true;
        love.stop();
        wait.remove();
      }
      md += chunk;
      if (!paintTimer) paintTimer = setTimeout(paint, 150);
    },
  };

  try {
    if (!navigator.onLine) throw new Problem('OFFLINE');
    const skill = await loadSkill('ask');
    const parts = [{ text: askPrompt(target.md, entry) }];
    const result = await generate({ key, skill, parts, signal: controller.signal, thoughts: false }, progress, ASK_MODELS);
    paint();
    const stopped = stopReason(result.finishReason);
    if (!md.trim()) throw stopped || new Problem('EMPTY_ANSWER');
    if (stopped) throw stopped;
    entry.answer = md.trim();
    box.dataset.state = 'done';
    if (current === target && !target.qa.includes(entry)) {
      target.qa.push(entry);
      target.qa.sort((a, b) => a.at - b.at);
      remember();
    }
  } catch (error) {
    if (md.trim()) paint();
    else clearTimeout(paintTimer);
    wait.remove();
    if (box.isConnected) {
      let problem = classify(error, { offline: !navigator.onLine, hidden: asking.hidden, partial: Boolean(md.trim()) });
      if (problem.code === 'LIMIT_DAY') problem = new Problem('ASK_LIMIT_DAY', problem.vars);
      box.dataset.state = 'failed';
      showBoxProblem(box, problem, target);
    }
  } finally {
    love.stop();
    asking = null;
    setAsking(false);
  }
}

// A problem shown inside the question's own box, from the same catalog, with Try again (after a
// countdown for a per-minute limit) or Change key when one of those helps.
function showBoxProblem(box, problem, target) {
  const info = describe(problem);
  const panel = document.createElement('div');
  panel.className = 'qa-problem';
  panel.setAttribute('role', 'alert');
  const [title, body, code] = noticeNodes(problem);
  panel.append(title, body);
  if (info.action === 'retry' || info.action === 'wait') {
    const retry = makeButton('button primary qa-retry', 'Try again');
    retry.addEventListener('click', () => {
      if (!retry.disabled && !asking) answerQuestion(box, target);
    });
    panel.append(buttonRow(retry));
    if (info.action === 'wait') boxCountdowns.set(box, countdown(retry, problem.vars.wait || 60));
  } else if (info.action === 'key') {
    const fix = makeButton('button secondary', 'Change key');
    fix.addEventListener('click', () => show('setup'));
    panel.append(buttonRow(fix));
  }
  panel.append(code);
  box.append(panel);
}

function removeQuestion(box) {
  if (asking && asking.box === box) asking.controller.abort();
  stopBoxCountdown(box);
  const entry = boxEntries.get(box);
  if (current && entry && current.qa.includes(entry)) {
    current.qa = current.qa.filter((item) => item !== entry);
    remember();
  }
  const section = box.closest('.qa-orphans');
  box.remove();
  if (section && !section.querySelector('.qa')) section.remove();
}

function stopBoxCountdown(box) {
  const stop = boxCountdowns.get(box);
  if (stop) stop();
  boxCountdowns.delete(box);
}

// One question at a time: Ask waits while an answer is coming.
function setAsking(busy) {
  ui.ask.disabled = busy;
  ui.askLabel.textContent = busy ? 'Answering your question…' : 'Ask about this';
  ui.askSend.disabled = busy;
  for (const chip of ui.chips) chip.disabled = busy;
}

function shorten(text, max) {
  const clean = normal(text);
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?–—-]+$/, '')}…`;
}

function paragraph(className, text) {
  const element = document.createElement('p');
  element.className = className;
  element.textContent = text;
  return element;
}

function makeButton(className, text) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = text;
  return element;
}

function buttonRow(...children) {
  const row = document.createElement('div');
  row.className = 'row';
  row.append(...children);
  return row;
}

// Saved questions, checked before use: only finished answers are kept.
function cleanQa(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && typeof item.question === 'string' && typeof item.answer === 'string' && item.answer.trim())
    .map((item) => ({
      quote: String(item.quote || '').slice(0, QUOTE_MAX),
      question: item.question.slice(0, QUESTION_MAX),
      answer: item.answer,
      index: Number.isInteger(item.index) ? item.index : -1,
      fp: String(item.fp || ''),
      at: Number(item.at) || 0,
    }));
}

document.addEventListener('visibilitychange', () => {
  if (asking && document.hidden) asking.hidden = true;
  if (!job) return;
  if (document.hidden) job.hidden = true;
  else keepAwake();
});

document.addEventListener('selectionchange', () => {
  const found = readSelection();
  if (found) {
    picked = found;
    clearTimeout(hideAsk);
    hideAsk = 0;
    ui.ask.hidden = false;
  } else if (!ui.ask.hidden && !hideAsk) {
    // iOS often clears the selection as the button is tapped, so the button stays a moment longer.
    hideAsk = setTimeout(() => {
      hideAsk = 0;
      if (!readSelection()) forgetSelection();
    }, 800);
  }
});

ui.ask.addEventListener('pointerdown', () => {
  held = picked;
  clearTimeout(hideAsk);
  hideAsk = 0;
});

ui.ask.addEventListener('click', () => {
  const selection = held || picked;
  held = null;
  if (selection && !asking) openAsk(selection);
});

ui.askForm.addEventListener('submit', (event) => {
  event.preventDefault();
  sendQuestion(ui.askInput.value);
});

ui.askInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    ui.askForm.requestSubmit();
  }
});

for (const chip of ui.chips) chip.addEventListener('click', () => sendQuestion(chip.dataset.question));
ui.askCancel.addEventListener('click', closeAsk);
ui.askDialog.addEventListener('click', (event) => {
  if (event.target === ui.askDialog) closeAsk(); // a tap on the dimmed page around the form
});
ui.askDialog.addEventListener('close', () => {
  chosen = null;
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
      qa: cleanQa(saved.qa),
    };
    display(current);
  }
} catch { /* ignore a damaged saved handbook */ }
show(getKey() ? 'pick' : 'setup');
