import { renderDiagram } from './diagram.js';

// A small Markdown renderer that is safe by construction: it builds DOM nodes with
// createElement and text nodes and never parses HTML, so anything the model writes
// (<script>, onerror=..., javascript: links) ends up as plain, inert text.

const BLANK = /^\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const ITEM = /^(\s*)([-*+•]|\d{1,9}[.)])\s+(.*)$/;
const DIVIDER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const INLINE = /\\([\\`*_{}[\]()#+\-.!|~<>])|(`+)([\s\S]*?[^`])\2(?!`)|(\*\*|__)(?=\S)([\s\S]*?\S)\4|(\*|_)(?=[^\s*_])([\s\S]*?[^\s\\])\6|~~(?=\S)([\s\S]*?\S)~~|(!?)\[([^\]\n]*)\]\(\s*<?([^\s)>]*)>?(?:\s+"[^"\n]*")?\s*\)|<br\s*\/?>/gi;

export function renderMarkdown(markdown) {
  const fragment = document.createDocumentFragment();
  blocks(String(markdown || '').replace(/\r\n?/g, '\n').split('\n'), fragment);
  for (const heading of fragment.querySelectorAll('h1, h2')) {
    if (/revision sheet/i.test(heading.textContent)) heading.classList.add('new-page');
  }
  return fragment;
}

function node(tag, text) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}

function blocks(lines, parent) {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let match;
    if (BLANK.test(line)) {
      i += 1;
    } else if ((match = FENCE.exec(line))) {
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(match[1])) body.push(lines[i++]);
      i += 1;
      const diagram = match[2].toLowerCase() === 'diagram' ? renderDiagram(body.join('\n')) : null;
      if (diagram) {
        const figure = parent.appendChild(node('figure'));
        figure.className = 'diagram-figure';
        figure.append(diagram);
      } else {
        parent.appendChild(node('pre')).append(node('code', body.join('\n')));
      }
    } else if ((match = HEADING.exec(line))) {
      inline(match[2], parent.appendChild(node(`h${match[1].length}`)));
      i += 1;
    } else if (RULE.test(line)) {
      parent.append(node('hr'));
      i += 1;
    } else if (isTable(lines, i)) {
      i = table(lines, i, parent);
    } else if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(QUOTE.exec(lines[i++])[1]);
      blocks(inner, parent.appendChild(node('blockquote')));
    } else if (ITEM.test(line)) {
      i = list(lines, i, parent);
    } else {
      const text = [line.trim()];
      i += 1;
      while (i < lines.length && !BLANK.test(lines[i]) && !startsBlock(lines, i)) text.push(lines[i++].trim());
      inline(text.join(' '), parent.appendChild(node('p')));
    }
  }
}

function startsBlock(lines, i) {
  const line = lines[i];
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || isTable(lines, i);
}

function isTable(lines, i) {
  const next = lines[i + 1];
  return lines[i].includes('|') && next !== undefined && next.includes('|') && next.includes('-') && DIVIDER.test(next);
}

function table(lines, i, parent) {
  const head = cells(lines[i]);
  const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'al-center' : /-:$/.test(c) ? 'al-right' : ''));
  const wrap = parent.appendChild(node('div'));
  wrap.className = 'table-wrap';
  const tableElement = wrap.appendChild(node('table'));
  const headRow = tableElement.appendChild(node('thead')).appendChild(node('tr'));
  head.forEach((text, k) => cell('th', text, align[k], headRow));
  const body = tableElement.appendChild(node('tbody'));
  i += 2;
  while (i < lines.length && !BLANK.test(lines[i]) && lines[i].includes('|')) {
    const values = cells(lines[i++]);
    const row = body.appendChild(node('tr'));
    head.forEach((_, k) => cell('td', values[k] || '', align[k], row));
  }
  return i;
}

function cell(tag, text, className, row) {
  const element = row.appendChild(node(tag));
  if (className) element.className = className;
  inline(text, element);
}

function cells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out = [];
  let current = '';
  let inCode = false;
  for (let k = 0; k < s.length; k += 1) {
    const ch = s[k];
    if (ch === '\\' && s[k + 1] === '|') {
      current += '|';
      k += 1;
    } else if (ch === '|' && !inCode) {
      out.push(current.trim());
      current = '';
    } else {
      if (ch === '`') inCode = !inCode;
      current += ch;
    }
  }
  out.push(current.trim());
  return out;
}

function list(lines, i, parent) {
  const stack = [];
  let lastItem = null;
  while (i < lines.length) {
    const line = lines[i];
    if (BLANK.test(line)) {
      let j = i + 1;
      while (j < lines.length && BLANK.test(lines[j])) j += 1;
      if (j < lines.length && ITEM.test(lines[j]) && !RULE.test(lines[j])) {
        i = j;
        continue;
      }
      break;
    }
    const match = RULE.test(line) ? null : ITEM.exec(line);
    if (!match) {
      if (!lastItem || startsBlock(lines, i)) break;
      lastItem.append(' ');
      inline(line.trim(), lastItem);
      i += 1;
      continue;
    }
    const indent = match[1].replace(/\t/g, '    ').length;
    const ordered = /^\d/.test(match[2]);
    while (stack.length > 1 && indent < stack[stack.length - 1].indent) stack.pop();
    let level = stack[stack.length - 1];
    if (!level || (level.item && indent >= level.indent + 2)) {
      const listElement = node(ordered ? 'ol' : 'ul');
      const start = parseInt(match[2], 10);
      if (ordered && start > 1) listElement.start = start;
      (level ? level.item : parent).append(listElement);
      level = { indent, list: listElement, item: null };
      stack.push(level);
    }
    lastItem = level.list.appendChild(node('li'));
    level.item = lastItem;
    inline(match[3], lastItem);
    i += 1;
  }
  return i;
}

function inline(text, parent) {
  const pattern = new RegExp(INLINE.source, 'gi');
  let last = 0;
  let match;
  while ((match = pattern.exec(text))) {
    const start = match.index;
    if ((match[6] === '_' || match[4] === '__') && (isWord(text[start - 1]) || isWord(text[pattern.lastIndex]))) {
      pattern.lastIndex = start + 1; // snake_case words are not emphasis
      continue;
    }
    if (start > last) parent.append(text.slice(last, start));
    last = pattern.lastIndex;
    if (match[1] !== undefined) parent.append(match[1]);
    else if (match[2] !== undefined) parent.append(node('code', match[3]));
    else if (match[4] !== undefined) inline(match[5], parent.appendChild(node('strong')));
    else if (match[6] !== undefined) inline(match[7], parent.appendChild(node('em')));
    else if (match[8] !== undefined) inline(match[8], parent.appendChild(node('s')));
    else if (match[10] !== undefined) link(match[9], match[10], match[11], parent);
    else parent.append(node('br'));
  }
  if (last < text.length) parent.append(text.slice(last));
}

function link(bang, label, url, parent) {
  if (bang) {
    if (label) parent.append(`[${label}]`); // images: show the description, never load them
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    inline(label, parent); // drop javascript:, data: and other non-web links
    return;
  }
  const anchor = parent.appendChild(node('a'));
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  inline(label, anchor);
}

function isWord(ch) {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}
