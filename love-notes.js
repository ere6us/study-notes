// Love notes: one short line at a time under the status while Gemini works. The lines live in
// love-notes.md, which is loaded on every run like the skills: each "## Stage" heading starts a
// pool and each "- " bullet is one line. Every pool is a shuffle bag, remembered between visits,
// so no line comes back until all the others in its pool have been shown.
const BAG_ITEM = 'handbook.loveNotes';
const EVERY_MS = 7000;
const FADE_MS = 400;

let bags = null; // per pool: { sig, left, last }

/** Lines by lower-case stage name, for example { reading: ['…'], 'still waiting': ['…'] }. */
export function parseLoveNotes(source) {
  const pools = {};
  let pool = null;
  for (const raw of String(source || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^##(?!#)\s*(.*?)[\s#:]*$/.exec(line);
    if (heading) {
      pool = heading[1].toLowerCase().replace(/\s+/g, ' ') || null;
      if (pool && !pools[pool]) pools[pool] = [];
      continue;
    }
    const bullet = /^[-*+]\s+(.+)$/.exec(line);
    if (!pool || !bullet || /^[\s*_-]+$/.test(bullet[1]) || pools[pool].includes(bullet[1])) continue;
    pools[pool].push(bullet[1]);
  }
  for (const name of Object.keys(pools)) if (!pools[name].length) delete pools[name];
  return pools;
}

/** Fetches and reads love-notes.md. Any failure just means no lines. */
export async function loadLoveNotes(url = 'love-notes.md') {
  try {
    const response = await fetch(url, { cache: 'no-cache' });
    return response.ok ? parseLoveNotes(await response.text()) : {};
  } catch {
    return {};
  }
}

function readBags() {
  if (!bags) {
    try {
      bags = JSON.parse(localStorage.getItem(BAG_ITEM) || '{}');
    } catch { /* blocked or damaged: start afresh */ }
    if (!bags || typeof bags !== 'object' || Array.isArray(bags)) bags = {};
  }
  return bags;
}

function signature(lines) {
  let hash = 0;
  for (const char of lines.join('\n')) hash = (Math.imul(hash, 31) + char.codePointAt(0)) | 0;
  return `${lines.length}:${hash >>> 0}`;
}

function shuffled(lines, avoid) {
  const out = [...lines];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  if (out.length > 1 && out[0] === avoid) {
    const j = 1 + Math.floor(Math.random() * (out.length - 1));
    [out[0], out[j]] = [out[j], out[0]];
  }
  return out;
}

// The next line from a pool's bag. A used-up bag, or one whose lines were edited, is refilled in a
// new random order that never starts with the line shown last.
function draw(name, lines) {
  const all = readBags();
  const sig = signature(lines);
  const bag = all[name] && typeof all[name] === 'object' ? all[name] : {};
  let left = bag.sig === sig && Array.isArray(bag.left) ? bag.left.filter((line) => lines.includes(line)) : [];
  if (!left.length) left = shuffled(lines, bag.last);
  const line = left.shift();
  all[name] = { sig, left, last: line };
  try {
    localStorage.setItem(BAG_ITEM, JSON.stringify(all));
  } catch { /* storage is blocked: the bags last for this visit only */ }
  return line;
}

const minutesText = (n) => (n === 1 ? '1 minute' : `${n} minutes`);

/**
 * Love notes for one run, shown in element (decorative, so aria-hidden). notes is a promise of the
 * parsed pools and thing is "handbook" or "explanation". Call use(stage) when the stage changes
 * (the same stage again changes nothing), minute(n) at each full minute of the run, and stop() at
 * the end.
 */
export function startLoveNotes(element, { notes, thing }) {
  let pools = null;
  let pool = '';
  let minutes = 0;
  let timer = 0;
  let stopped = false;

  const fill = (line) => line.replaceAll('{thing}', thing).replaceAll('{time}', minutesText(Math.max(1, minutes)));

  function render(words) {
    const line = document.createElement('span');
    line.className = 'love-line';
    line.textContent = words;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      element.replaceChildren(line);
      return;
    }
    // Cross-fade: the old line fades out while the new one fades in, in the same place.
    for (const old of element.querySelectorAll('.love-line:not(.leaving)')) {
      old.classList.add('leaving');
      setTimeout(() => old.remove(), FADE_MS);
    }
    line.classList.add('entering');
    element.append(line);
    void line.offsetWidth; // start from transparent so the fade-in runs
    line.classList.remove('entering');
  }

  function next(name = pool) {
    clearTimeout(timer);
    if (stopped || !pools) return;
    const lines = pools[name] || [];
    if (!lines.length) {
      element.replaceChildren();
      return;
    }
    render(fill(draw(name, lines)));
    timer = setTimeout(() => next(), EVERY_MS);
  }

  element.replaceChildren();
  element.hidden = false; // holds its space while the lines load, so nothing jumps
  notes.then((loaded) => {
    if (stopped) return;
    pools = loaded || {};
    if (!Object.keys(pools).length) element.hidden = true;
    else if (pool) next();
  });

  return {
    use(name) {
      if (name === pool) return;
      pool = name;
      next();
    },
    minute(n) {
      minutes = n;
      if (pools && pools['still waiting']) next('still waiting');
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      element.replaceChildren();
      element.hidden = true;
    },
  };
}
