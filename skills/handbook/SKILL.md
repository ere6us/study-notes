---
name: handbook
description: Turns class notes, lecture handouts and teachers' slide decks (PDF) into a simple bullet-point study handbook for memorizing and exam revision. Use when a student wants notes simplified, summarized into revision notes, or turned into a handbook or cheat sheet.
---

# Study handbook

Turn the student's class material (typed notes, handouts, or slides saved as PDF) into a handbook they can read, memorize and revise from.

## Ground rules

- Use only what is in the document. Don't add facts, examples or explanations that aren't there.
- Don't guess. If something is unclear, cut off, unreadable or looks wrong, write `⚠ Unclear in notes:` and say briefly what is missing.
- Keep every definition, formula, law, number, unit, date and name exactly as written in the notes.
- Cover everything that could come up in an exam, in the same order as the notes. Simplify the wording, not the content.
- Skip filler: title slides, agendas, "any questions?" slides, logos, page numbers, and repeated headers and footers.
- Write in the same language as the notes.

## How to write it

- Use plain, simple words and short bullets: one idea per bullet, about 20 words at most.
- **Bold** the key terms a student must be able to recall.
- Definitions go on one bullet: `**Term**: meaning`, using the wording from the notes.
- Put each formula on its own bullet inside backticks, using plain text and Unicode symbols (², √, π, Δ, ≤, →), never LaTeX. On the next bullet, say what each symbol means.
- Use a table to compare two or more things (differences, types, properties, pros and cons).
- Use a numbered list for steps, processes and sequences.
- For diagrams, charts and pictures on slides, describe what they show in 1–3 bullets.
- Where it helps something stick, add a memory hook (mnemonic, acronym, rhyme or simple analogy) as a bullet starting with `💡 Memory hook:`. Never invent facts in a hook.

## Structure

1. `# Title`: the subject or topic of the document.
2. One `## Section` per main topic, in the order of the notes. Inside a section use bullets, `### Subsections`, tables and numbered steps as needed.
3. End every section with a short must-remember list, written as a quote block:

   ```markdown
   > **Must remember**
   > - the 3–5 most exam-worthy points of this section
   ```

4. Finish with `## One-page revision sheet`: the whole document squeezed onto one printed page. Use very short bullets with the key terms, formulas and facts, grouped by section.

## Output

- Output only the handbook in Markdown: no greeting, preamble or closing remarks.
- Use only headings, bullets, numbered lists, bold, italics, tables, quote blocks and `code`. No HTML tags, LaTeX, images or links (unless the notes contain the link).
- If the document has no readable study content (blank pages, an unreadable scan, or not study material), reply with exactly one line: `NO_CONTENT_FOUND: <short reason>`.
