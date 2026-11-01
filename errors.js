// Every problem the app can run into, in everyday words: what happened, what to do next, and which
// button helps. A short code is shown in small print so the site owner can debug from a screenshot.

export class Problem extends Error {
  constructor(code, vars = {}) {
    super(code);
    this.name = 'Problem';
    this.code = code;
    this.vars = vars;
  }
}

// An HTTP error from Google, kept raw so classify() can read Google's reason codes.
export class ApiError extends Error {
  constructor(status, info, stage = '') {
    super((info && info.message) || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = Number(status) || 0;
    this.details = (info && Array.isArray(info.details) && info.details) || [];
    this.stage = stage;
  }

  static async from(response, stage) {
    let info = null;
    try {
      const body = await response.json();
      info = (Array.isArray(body) ? body[0] : body).error;
    } catch { /* not JSON */ }
    return new ApiError(response.status, info, stage);
  }
}

// A request that never got an answer: offline, a dropped connection, or a page iOS suspended.
export class NetworkFailure extends Error {
  constructor(stage = '') {
    super('network');
    this.name = 'NetworkFailure';
    this.stage = stage;
  }
}

// action: 'retry' shows Try again, 'wait' shows Try again after a countdown, 'key' shows Change key,
// 'pick' and 'photos' point back at the file buttons, 'none' needs no button.
const CATALOG = {
  OFFLINE: {
    title: "You're offline",
    body: 'Connect to Wi-Fi or mobile data, then tap Try again.',
    action: 'retry',
  },
  NETWORK: {
    title: "Couldn't reach Google",
    body: 'The connection failed before Gemini could answer. Check your internet and keep this screen open, then tap Try again.',
    action: 'retry',
  },
  CONNECTION_LOST: {
    title: 'The connection dropped part-way',
    body: "What Gemini wrote so far is below, and you can save it now. Tap Try again for the full version, and keep this screen open until it's done.",
    action: 'retry',
  },
  SUSPENDED: {
    title: 'It stopped when the screen locked',
    body: "iPhones pause web pages when the screen locks or you switch apps. Tap Try again and keep this screen on until it's done.",
    action: 'retry',
  },
  KEY_INVALID: {
    title: "Google didn't accept your key",
    body: 'Copy your key again from Google AI Studio (it usually starts with AIza), tap Change key and paste it.',
    action: 'key',
  },
  KEY_BLOCKED: {
    title: "Google won't let this key be used",
    body: 'The key may have been turned off, limited to other websites, or reported as leaked. Make a new free key in Google AI Studio, tap Change key and paste it.',
    action: 'key',
  },
  NO_FREE_QUOTA: {
    title: 'This key has no free Gemini allowance',
    body: "Google gives this key's project no free use of the Gemini models. In Google AI Studio, create a key in a new project (still free), tap Change key and paste it.",
    action: 'key',
  },
  LIMIT_MINUTE: {
    title: 'Too many requests this minute',
    body: "Gemini's free plan allows only a few requests a minute. Try again when the timer ends.",
    action: 'wait',
  },
  LIMIT_SIZE_MINUTE: {
    title: 'This file is a lot to read in one minute',
    body: 'The free plan limits how much Gemini can read each minute. Try again when the timer ends. If it happens again, split the file into smaller parts.',
    action: 'wait',
  },
  LIMIT_DAY: {
    title: "You've used today's free handbooks",
    body: "Google's free plan allows a set number each day, and today's are used up. They reset at {reset}. Everything you've already made stays here.",
    action: 'none',
  },
  BUSY: {
    title: 'Gemini is busy right now',
    body: "Google's servers are overloaded. Wait a minute, then tap Try again.",
    action: 'retry',
  },
  TIMEOUT: {
    title: 'Gemini took too long',
    body: 'Very long files can time out. Tap Try again, and if it happens again, split the file into smaller parts.',
    action: 'retry',
  },
  BLOCKED: {
    title: 'Gemini refused to finish',
    body: "Google's safety filter stopped it, which sometimes happens with medical or legal topics. Tap Try again, or leave out the pages that might be flagged.",
    action: 'retry',
  },
  RECITATION: {
    title: 'Gemini stopped to avoid copying a book',
    body: 'It stops when its words match a published text too closely. Tap Try again: each try comes out differently.',
    action: 'retry',
  },
  CUT_SHORT: {
    title: 'This handbook stops early',
    body: 'The file is very long, so Gemini ran out of room. Split it into smaller parts (for example, one chapter each) and make one for each part.',
    action: 'none',
  },
  PARTIAL: {
    title: 'This handbook is incomplete',
    body: "It stopped part-way. Make it again for the full version, and keep the screen on until it's done.",
    action: 'none',
  },
  STOPPED: {
    title: 'Stopped',
    body: 'Nothing was lost. Tap Try again, or choose another file.',
    action: 'retry',
  },
  UPLOAD_FAILED: {
    title: "The file didn't upload",
    body: 'Big files are sent to Google first, and that upload failed. Check your internet and keep this screen open, then tap Try again.',
    action: 'retry',
  },
  PROCESSING_FAILED: {
    title: "Google couldn't read this file",
    body: 'It may be damaged or locked with a password. Open it, save a fresh copy as PDF, and choose that copy.',
    action: 'pick',
  },
  PROCESSING_TIMEOUT: {
    title: 'Google took too long to prepare the file',
    body: 'Tap Try again in a minute. If it happens again, split the file into smaller parts.',
    action: 'retry',
  },
  TOO_BIG: {
    title: 'This file is too big',
    body: '{name} is {size}, and the limit is {limit}. Split it into smaller parts (for example, one chapter each) and make one for each part.',
    action: 'pick',
  },
  TOO_MUCH_AT_ONCE: {
    title: 'This is too much to send at once',
    body: 'Split the file into smaller parts, or choose fewer photos, and make one for each part.',
    action: 'pick',
  },
  TOO_MANY_PAGES: {
    title: 'This PDF has too many pages',
    body: 'Gemini reads up to 1,000 pages at a time. Split the PDF into smaller parts and make one for each part.',
    action: 'pick',
  },
  TOO_MANY_PHOTOS: {
    title: 'Too many photos at once',
    body: 'You picked {count}. Choose up to {max} at a time, and make one for each batch.',
    action: 'photos',
  },
  MIXED_FILES: {
    title: 'Choose one kind of file',
    body: 'Pick one PDF or PowerPoint file, or up to 30 photos, but not both at once.',
    action: 'pick',
  },
  OLD_PPT: {
    title: 'This is an older PowerPoint file',
    body: '{name} uses the old .ppt format. Open it in PowerPoint or Keynote, save it as .pptx or PDF once, then choose that copy.',
    action: 'pick',
  },
  KEYNOTE: {
    title: 'Keynote files need one export',
    body: 'In Keynote, use Share, then Export, and choose PowerPoint or PDF. Then choose that copy here.',
    action: 'pick',
  },
  GOOGLE_SLIDES: {
    title: 'Google Slides need one download',
    body: 'In Google Slides, download the presentation as PowerPoint (.pptx) or PDF, then choose that copy here.',
    action: 'pick',
  },
  UNSUPPORTED: {
    title: "This kind of file can't be read",
    body: "{name} isn't a PDF, a PowerPoint file (.pptx) or a photo. Save it as PDF first, then choose that.",
    action: 'pick',
  },
  FILE_UNREADABLE: {
    title: "This file can't be opened",
    body: 'It may be damaged, or still downloading from iCloud. Open it once in the Files app, then choose it again.',
    action: 'pick',
  },
  PASSWORD: {
    title: 'This file is locked with a password',
    body: 'Gemini can only read unlocked files. Save a copy without the password (or as PDF), then choose that copy.',
    action: 'pick',
  },
  SLIDES_EMPTY: {
    title: 'Nothing readable in these slides',
    body: "The slides have no text, and their pictures are in a format this phone can't read here. In PowerPoint or Keynote, export the slides as PDF and choose that.",
    action: 'pick',
  },
  PHOTO_UNREADABLE: {
    title: "A photo couldn't be opened",
    body: "{name} is in a format this browser can't read here (often HEIC). Take a screenshot of it and use that, or set Settings, Camera, Formats to Most Compatible.",
    action: 'photos',
  },
  UPDATE_IOS: {
    title: 'This needs a newer iOS',
    body: 'Reading PowerPoint files here needs iOS 16.4 or later. Update your iPhone, or export the slides as PDF and choose that.',
    action: 'pick',
  },
  STORAGE_BLOCKED: {
    title: "This browser won't remember your key",
    body: "Private Browsing or a setting is blocking storage, so you'll need to paste the key again next time. To avoid that, open the site in a normal Safari tab.",
    action: 'none',
  },
  SKILL_MISSING: {
    title: "The instructions for Gemini didn't load",
    body: 'Check your internet, then tap Try again. If it keeps happening, tell the person who set up this site.',
    action: 'retry',
  },
  NO_CONTENT: {
    title: 'No study content found',
    body: 'Gemini found nothing to study in {name}{reason}. For scans and photos, make sure the pages are clear and the right way up.',
    action: 'pick',
  },
  EMPTY_ANSWER: {
    title: 'Gemini sent back an empty answer',
    body: 'This happens now and then. Tap Try again.',
    action: 'retry',
  },
  MODEL_GONE: {
    title: 'The AI models this site uses have changed',
    body: 'Google retired them. Tell the person who set up this site to update the model names in gemini.js.',
    action: 'none',
  },
  REGION: {
    title: "Gemini's free plan isn't available here",
    body: "Google doesn't offer the free Gemini API in your country or region yet.",
    action: 'none',
  },
  PRINT_UNAVAILABLE: {
    title: "The print screen didn't open",
    body: "iPhone can't print from a Home Screen web app. Tap Copy text and paste it into Notes or Pages, which can save PDFs. Next time, open the site in Safari, or add it to your Home Screen again with Open as Web App turned off.",
    action: 'none',
  },
  COPY_FAILED: {
    title: "Couldn't copy",
    body: 'Select the text in the handbook and copy it instead.',
    action: 'none',
  },
  UNKNOWN: {
    title: 'Something unexpected went wrong',
    body: 'Tap Try again. If it keeps happening, take a screenshot of this message for the person who set up this site.',
    action: 'retry',
  },
};

export function describe(problem) {
  const known = Boolean(CATALOG[problem.code]);
  const entry = known ? CATALOG[problem.code] : CATALOG.UNKNOWN;
  const vars = problem.vars || {};
  const fill = (text) => text.replace(/\{(\w+)\}/g, (_, name) => (vars[name] === undefined ? '' : String(vars[name])));
  const code = known ? problem.code : 'UNKNOWN';
  return {
    code: vars.detail ? `${code} (${vars.detail})` : code,
    title: fill(entry.title),
    body: fill(entry.body),
    action: entry.action,
  };
}

// Turns anything thrown into a Problem. context: { offline, hidden, partial }.
export function classify(error, context = {}) {
  if (error instanceof Problem) return error;
  if (error && error.name === 'AbortError') return new Problem('STOPPED');
  if (error instanceof ApiError) return fromApi(error);
  if (error instanceof NetworkFailure || isNetworkError(error)) {
    if (context.offline) return new Problem('OFFLINE');
    if (context.hidden) return new Problem('SUSPENDED');
    if (error.stage === 'upload') return new Problem('UPLOAD_FAILED');
    return new Problem(context.partial ? 'CONNECTION_LOST' : 'NETWORK');
  }
  return new Problem('UNKNOWN', { detail: (error && error.name) || 'Error' });
}

function isNetworkError(error) {
  return error instanceof TypeError && /load failed|failed to fetch|network|connection|offline/i.test(error.message);
}

function fromApi(error) {
  const { status, stage } = error;
  const text = `${error.message} ${JSON.stringify(error.details)}`;
  if (status === 401 || /API_KEY_INVALID|API_KEY_EXPIRED|API key not valid|API key expired/i.test(text)) return new Problem('KEY_INVALID');
  if (/location is not supported/i.test(text)) return new Problem('REGION');
  if (status === 403) return new Problem('KEY_BLOCKED');
  if (status === 429) {
    if (/limit:\s*0\b/.test(text)) return new Problem('NO_FREE_QUOTA');
    if (/PerDay/i.test(text)) return new Problem('LIMIT_DAY', { reset: quotaResetTime() });
    return new Problem(/Token/i.test(text) ? 'LIMIT_SIZE_MINUTE' : 'LIMIT_MINUTE', { wait: retrySeconds(error.details) });
  }
  if (status === 413 || /payload size|request entity too large|request is too large/i.test(text)) return new Problem('TOO_MUCH_AT_ONCE');
  if (/1,?000 pages|too many pages|page limit/i.test(text)) return new Problem('TOO_MANY_PAGES');
  if (/password|encrypted/i.test(text)) return new Problem('PASSWORD');
  if (stage === 'upload' && (status === 404 || status >= 500)) return new Problem('UPLOAD_FAILED');
  if (status === 404) return new Problem('MODEL_GONE');
  if (status === 504 || /DEADLINE_EXCEEDED/.test(text)) return new Problem('TIMEOUT');
  if (status >= 500) return new Problem('BUSY');
  if (status === 400 && /document|pdf|image|mime|file|unsupported|unable to process/i.test(text)) return new Problem('PROCESSING_FAILED');
  return new Problem('UNKNOWN', { detail: `HTTP ${status}` });
}

function retrySeconds(details) {
  const info = (details || []).find((item) => item && typeof item.retryDelay === 'string');
  const seconds = info ? Math.ceil(parseFloat(info.retryDelay)) : NaN;
  return seconds > 0 ? Math.min(seconds, 600) : 60;
}

// Free daily limits reset at midnight Pacific time; say when that is in the student's own time zone.
export function quotaResetTime(now = Date.now()) {
  try {
    const hourInCalifornia = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' });
    let time = Math.ceil(now / 3600000) * 3600000;
    for (let i = 0; i < 26; i += 1, time += 3600000) {
      if (Number(hourInCalifornia.format(time)) === 0) {
        const at = new Date(time);
        const day = at.toDateString() === new Date(now).toDateString() ? 'today' : 'tomorrow';
        return `${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} ${day} (your time)`;
      }
    }
  } catch { /* fall through */ }
  return 'midnight, California time';
}
