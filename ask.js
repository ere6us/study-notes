// Where questions about the handbook sit. Each question belongs to the passage she selected, and
// its answer box goes right under that passage. Boxes are saved with the handbook and placed again
// on the next visit: by the passage's position and the start of its words, then by searching for
// the words she selected, and otherwise in a "My questions" section at the end.

// Must-remember boxes, tables, diagrams and code blocks are kept whole, so a question about
// anything inside one goes right after it.
const UNITS = 'blockquote, .table-wrap, .diagram-figure, pre';
const PASSAGES = `li, p, h1, h2, h3, h4, h5, h6, ${UNITS}`;
const BOXES = '.qa, .qa-orphans';

export const normal = (text) => String(text || '').replace(/\s+/g, ' ').trim();
const compact = (text) => String(text || '').replace(/\s+/g, '');

/** The handbook's own passages, in order, leaving out question boxes and what's inside them. */
export function passagesOf(root) {
  return [...root.querySelectorAll(PASSAGES)].filter((el) => !el.closest(BOXES));
}

/** A passage's own words, without any question boxes placed inside it. */
export function ownText(passage) {
  if (!passage.querySelector(BOXES)) return passage.textContent;
  const copy = passage.cloneNode(true);
  for (const box of copy.querySelectorAll(BOXES)) box.remove();
  return copy.textContent;
}

/** The start of a passage's words, saved to check later that it's still the same passage. */
export const fingerprint = (passage) => normal(ownText(passage)).slice(0, 80);

// The element where a selection ends.
function endElement(range) {
  const { endContainer: node, endOffset: offset } = range;
  if (node.nodeType !== Node.ELEMENT_NODE) return node.parentElement;
  if (!offset) return node;
  let el = node.childNodes[offset - 1];
  if (el.nodeType !== Node.ELEMENT_NODE) return el.parentElement;
  while (el.lastElementChild) el = el.lastElementChild;
  return el;
}

/**
 * What a selection inside root is about: { passage } for a passage of the handbook, or { box } when
 * it ends inside a question box (a follow-up joins that box's passage). null for anything else.
 */
export function placeOfSelection(root, range) {
  const el = endElement(range);
  if (!el || el === root || !root.contains(el)) return null;
  const box = el.closest('.qa');
  if (box && root.contains(box)) return { box };
  if (el.closest('.qa-orphans')) return null;
  const unit = el.closest(UNITS);
  const passage = unit && root.contains(unit) ? unit : el.closest(PASSAGES);
  return passage && passage !== root && root.contains(passage) ? { passage } : null;
}

/**
 * The passage a saved question belongs to, or null for "My questions". texts holds each passage's
 * own words (normalized), in the same order as passages.
 */
export function findPassage(passages, texts, entry) {
  if (!(entry.index >= 0)) return null;
  if (passages[entry.index] && texts[entry.index].slice(0, 80) === entry.fp) return passages[entry.index];
  const tail = compact(entry.quote).slice(-40);
  if (!tail) return null;
  let found = null;
  for (let i = 0; i < passages.length; i += 1) {
    if (!compact(texts[i]).includes(tail)) continue;
    if (!found || found.contains(passages[i])) found = passages[i];
    else break;
  }
  return found ? found.closest(UNITS) || found : null;
}

/** Puts a question box under its passage, after any earlier boxes there. No passage: "My questions". */
export function attach(root, box, passage) {
  if (!passage) {
    let section = [...root.children].find((child) => child.classList.contains('qa-orphans'));
    if (!section) {
      section = document.createElement('section');
      section.className = 'qa-orphans';
      const heading = document.createElement('h2');
      heading.textContent = 'My questions';
      section.append(heading);
      root.append(section);
    }
    section.append(box);
    return;
  }
  if (passage.matches('li')) {
    // Inside the list item, under its words, so numbered lists keep their numbers.
    const nested = [...passage.children].find((child) => child.matches('ul, ol'));
    passage.insertBefore(box, nested || null);
    return;
  }
  let last = passage;
  while (last.nextElementSibling && last.nextElementSibling.matches('.qa')) last = last.nextElementSibling;
  last.after(box);
}
