import { ApiError, NetworkFailure, Problem, quotaResetTime } from './errors.js';

const BASE = 'https://generativelanguage.googleapis.com';
// Free-tier models, best first. Each has its own free daily allowance, so moving down the list
// stretches what the free plan gives. All three are stable with no announced shutdown date.
export const MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];
// Only tried if every model above has been retired (404).
export const LAST_RESORT = 'gemini-flash-latest';
// Google caps a whole request with inline data at 20 MB; stay under it and upload anything bigger.
export const INLINE_BUDGET = 18 * 1024 * 1024;
const PROCESSING_LIMIT_MS = 5 * 60 * 1000;
const FILE_NAME = /^files\/[\w-]+$/;

async function send(url, init, stage) {
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    throw new NetworkFailure(stage);
  }
  if (!response.ok) throw await ApiError.from(response, stage);
  return response;
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Stopped', 'AbortError'));
      }, { once: true });
    }
  });
}

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Problem('FILE_UNREADABLE', { name: blob.name || 'This file' }));
    reader.readAsDataURL(blob);
  });
}

// Inline parts while the request stays under the budget; upload the largest blobs beyond it.
// Names of uploaded files are pushed to `uploaded` as soon as they exist, so they can be deleted.
export async function prepareParts(parts, { key, signal, onStage = () => {}, uploaded = [] }) {
  const sizes = parts.map((part) => (part.blob ? Math.ceil(part.blob.size / 3) * 4 : (part.text || '').length));
  let total = sizes.reduce((sum, size) => sum + size, 0);
  const toUpload = new Set();
  const largestFirst = parts.map((_, i) => i).filter((i) => parts[i].blob).sort((a, b) => sizes[b] - sizes[a]);
  for (const i of largestFirst) {
    if (total <= INLINE_BUDGET) break;
    toUpload.add(i);
    total -= sizes[i];
  }
  const out = [];
  let count = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part.blob) {
      out.push({ text: part.text });
    } else if (toUpload.has(i)) {
      count += 1;
      onStage('upload', { n: count, total: toUpload.size });
      const file = await uploadFile(part, { key, signal, uploaded });
      out.push({ fileData: { mimeType: file.mimeType || part.mimeType, fileUri: file.uri } });
    } else {
      out.push({ inlineData: { mimeType: part.mimeType, data: await toBase64(part.blob) } });
    }
  }
  return out;
}

async function uploadFile(part, { key, signal, uploaded }) {
  const start = await send(`${BASE}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': key,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(part.blob.size),
      'X-Goog-Upload-Header-Content-Type': part.mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: part.name || 'notes' } }),
    signal,
  }, 'upload');
  // Browsers can't always read X-Goog-Upload-URL, but the upload ID is readable and the URL is built from it.
  const id = start.headers.get('x-guploader-uploadid');
  const url = start.headers.get('x-goog-upload-url')
    || (id ? `${BASE}/upload/v1beta/files?upload_id=${encodeURIComponent(id)}&upload_protocol=resumable` : '');
  if (!url) throw new Problem('UPLOAD_FAILED');
  const finished = await send(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'X-Goog-Upload-Command': 'upload, finalize', 'X-Goog-Upload-Offset': '0' },
    body: part.blob,
    signal,
  }, 'upload');
  let file = null;
  try {
    file = (await finished.json()).file;
  } catch { /* handled below */ }
  if (!file || !FILE_NAME.test(file.name || '') || !file.uri) throw new Problem('UPLOAD_FAILED');
  uploaded.push(file.name);
  const deadline = Date.now() + PROCESSING_LIMIT_MS;
  while (file.state === 'PROCESSING') {
    if (Date.now() > deadline) throw new Problem('PROCESSING_TIMEOUT');
    await wait(2000, signal);
    const check = await send(`${BASE}/v1beta/${file.name}`, { headers: { 'x-goog-api-key': key }, signal }, 'upload');
    file = { ...file, ...(await check.json()) };
  }
  if (file.state === 'FAILED') throw new Problem('PROCESSING_FAILED');
  return file;
}

// Uploaded files delete themselves after 48 hours; this removes them right away. Best effort.
export function forgetUploads(names, key) {
  for (const name of names) {
    if (!FILE_NAME.test(name)) continue;
    fetch(`${BASE}/v1beta/${name}`, { method: 'DELETE', headers: { 'x-goog-api-key': key } }).catch(() => {});
  }
}

// Streams one answer. Moves to the next free model only when a model is gone (404), has no free
// quota (limit: 0) or has used today's free requests; never on a per-minute limit, and never once
// text has started arriving. Returns { finishReason, model, backup } where backup says why the
// main model wasn't used ('day', 'no-quota', 'gone' or '').
export async function generate(request, progress) {
  const reasons = [];
  for (const model of [...MODELS, LAST_RESORT]) {
    if (model === LAST_RESORT && !reasons.every((reason) => reason === 'gone')) break;
    try {
      const finishReason = await stream({ ...request, model }, progress);
      return { finishReason, model, backup: reasons[0] || '' };
    } catch (error) {
      const reason = progress.gotText ? '' : unavailable(error);
      if (!reason) throw error;
      reasons.push(reason);
    }
  }
  if (reasons.includes('day')) throw new Problem('LIMIT_DAY', { reset: quotaResetTime() });
  if (reasons.includes('no-quota')) throw new Problem('NO_FREE_QUOTA');
  throw new Problem('MODEL_GONE');
}

function unavailable(error) {
  if (!(error instanceof ApiError)) return '';
  const text = `${error.message} ${JSON.stringify(error.details)}`;
  if (error.status === 404) return 'gone';
  if (error.status === 429 && /limit:\s*0\b/.test(text)) return 'no-quota';
  if (error.status === 429 && /PerDay/i.test(text)) return 'day';
  return '';
}

async function stream({ key, skill, parts, signal, model }, progress) {
  const response = await send(`${BASE}/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: skill }] },
      contents: [{ role: 'user', parts }],
      // Streaming thought summaries keeps the connection busy while the model plans.
      generationConfig: { thinkingConfig: { includeThoughts: true } },
    }),
    signal,
  }, 'generate');
  progress.stage('reading');

  let finishReason = '';
  const handle = (data) => {
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk.error) throw new ApiError(chunk.error.code, chunk.error, 'generate');
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
    let chunk;
    try {
      chunk = await reader.read();
    } catch (error) {
      if (error && error.name === 'AbortError') throw error;
      throw new NetworkFailure('stream');
    }
    buffer += decoder.decode(chunk.value || new Uint8Array(0), { stream: !chunk.done });
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith('data:')) handle(line.slice(5).trim());
    }
    if (chunk.done) break;
  }
  if (buffer.trim().startsWith('data:')) handle(buffer.trim().slice(5).trim());
  return finishReason;
}
