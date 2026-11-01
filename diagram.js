// Draws the small diagrams the skills ask Gemini for (flow, cycle, tree) as SVG, built only with
// createElementNS and textContent so a label can never become markup. Returns null when a block
// can't be parsed, and the caller shows it as plain text instead.

const SVG_NS = 'http://www.w3.org/2000/svg';
const WIDTH = 340;
const PAD_X = 12;
const PAD_Y = 10;
const LINE = 18;
const CHAR = 7.4; // average character width at 14px, used for wrapping
const ARROW_GAP = 28;
const TREE_GAP = 10;
const INDENT = 24;
const MAX_ITEMS = 24;

export function renderDiagram(source) {
  const spec = parse(source);
  if (!spec) return null;
  const svg = node('svg', { class: `diagram diagram-${spec.type}`, role: 'img' });
  svg.append(node('title', {}, spec.title || `${spec.type} diagram`));
  let top = 2;
  if (spec.title) {
    for (const line of wrap(spec.title, Math.floor(WIDTH / 8.6))) {
      top += 19;
      svg.append(node('text', { x: 2, y: top, class: 'dg-title' }, line));
    }
    top += 14;
  }
  const height = spec.type === 'tree' ? drawTree(svg, spec.items, top) : drawFlow(svg, spec.items, top, spec.type === 'cycle');
  svg.setAttribute('viewBox', `0 0 ${WIDTH} ${height}`);
  svg.setAttribute('width', String(WIDTH));
  svg.setAttribute('height', String(height));
  return svg;
}

function parse(source) {
  let type = '';
  let title = '';
  const items = [];
  for (const raw of String(source).replace(/\r/g, '').split('\n')) {
    if (!raw.trim()) continue;
    const header = /^\s*(type|title)\s*:\s*(.*)$/i.exec(raw);
    if (header && !items.length) {
      if (header[1].toLowerCase() === 'type') type = header[2].trim().toLowerCase();
      else title = clean(header[2]);
      continue;
    }
    const item = /^(\s*)(?:[-*+•]|\d{1,2}[.)])\s+(.*\S)\s*$/.exec(raw);
    if (!item) return null;
    items.push({ depth: item[1].replace(/\t/g, '  ').length, label: clean(item[2]) });
  }
  if (!['flow', 'cycle', 'tree'].includes(type) || items.length < 2 || items.length > MAX_ITEMS) return null;
  return { type, title, items };
}

function clean(text) {
  return text.replace(/\*\*|__|`/g, '').trim().slice(0, 160);
}

function drawFlow(svg, items, top, cycle) {
  const width = WIDTH - 4 - (cycle ? 46 : 0);
  const mids = [];
  let y = top;
  items.forEach((item, i) => {
    if (i) arrowDown(svg, 2 + width / 2, y - ARROW_GAP + 4, y - 3);
    const height = box(svg, 2, y, width, item.label, i === 0, 'middle');
    mids.push(y + Math.min(height / 2, 19));
    y += height + ARROW_GAP;
  });
  if (cycle) {
    const right = 2 + width;
    const x = right + 24;
    const first = mids[0];
    const last = mids[mids.length - 1];
    svg.append(node('path', { d: `M ${right} ${last} H ${x} V ${first} H ${right + 9}`, class: 'dg-line' }));
    svg.append(node('path', { d: `M ${right + 9} ${first - 5} L ${right + 1} ${first} L ${right + 9} ${first + 5} Z`, class: 'dg-head' }));
    const middle = (first + last) / 2;
    svg.append(node('text', {
      x: x + 12, y: middle, class: 'dg-note', 'text-anchor': 'middle', transform: `rotate(90 ${x + 12} ${middle})`,
    }, 'repeats'));
  }
  return y - ARROW_GAP + 4;
}

function drawTree(svg, items, top) {
  const base = items[0].depth;
  const parents = [];
  let previous = 0;
  let y = top;
  items.forEach((item, i) => {
    const depth = i === 0 ? 0 : Math.min(Math.max(Math.round((item.depth - base) / 2), 1), previous + 1, 3);
    const x = 2 + depth * INDENT;
    const height = box(svg, x, y, WIDTH - 4 - depth * INDENT, item.label, depth === 0, 'start');
    const parent = parents[depth - 1];
    if (parent) svg.append(node('path', { d: `M ${parent.x + 12} ${parent.bottom} V ${y + 19} H ${x}`, class: 'dg-line' }));
    parents[depth] = { x, bottom: y + height };
    parents.length = depth + 1;
    previous = depth;
    y += height + TREE_GAP;
  });
  return y - TREE_GAP + 4;
}

function box(svg, x, y, width, label, first, anchor) {
  const lines = wrap(label, Math.floor((width - 2 * PAD_X) / CHAR));
  const height = lines.length * LINE + 2 * PAD_Y;
  svg.append(node('rect', { x, y, width, height, rx: 12, class: first ? 'dg-box dg-first' : 'dg-box' }));
  const textX = anchor === 'middle' ? x + width / 2 : x + PAD_X;
  const text = node('text', { x: textX, y: y + PAD_Y + 13, class: 'dg-label', 'text-anchor': anchor });
  lines.forEach((line, i) => text.append(node('tspan', { x: textX, dy: i ? LINE : 0 }, line)));
  svg.append(text);
  return height;
}

function arrowDown(svg, x, y1, y2) {
  svg.append(node('path', { d: `M ${x} ${y1} V ${y2 - 7}`, class: 'dg-line' }));
  svg.append(node('path', { d: `M ${x - 6} ${y2 - 9} L ${x} ${y2} L ${x + 6} ${y2 - 9} Z`, class: 'dg-head' }));
}

function wrap(text, max) {
  const lines = [];
  let line = '';
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > max) {
      if (line) {
        lines.push(line);
        line = '';
      }
      lines.push(`${word.slice(0, max - 1)}-`);
      word = word.slice(max - 1);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= max) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function node(name, attrs = {}, text) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
}
