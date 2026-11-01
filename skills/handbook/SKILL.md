---
name: handbook
description: Turns class notes, lecture handouts, teachers' slide decks and photos of notes or textbook pages into a simple bullet-point study handbook for memorizing and exam revision. Use when a student wants notes simplified, summarized into revision notes, or turned into a handbook or cheat sheet.
---

# Study handbook

Turn the student's class material into a handbook they can read, memorize and revise from. The material can be a PDF, a slide deck (each slide's text, tables, chart data, SmartArt and speaker notes, followed by its pictures), or photos of notes, textbook pages, whiteboards or diagrams.

## Ground rules

- Use only what is in the material. Don't add facts, examples or explanations that aren't there.
- Don't guess. If something is unclear, cut off, unreadable or looks wrong, write `⚠ Unclear in notes:` and say briefly what is missing.
- Keep every definition, formula, law, number, unit, date and name exactly as written.
- Cover everything that could come up in an exam, in the same order as the material. Simplify the wording, not the content.
- Skip filler: title slides, agendas, "any questions?" slides, logos, page numbers, and repeated headers and footers.
- Write in the same language as the material.

## How to write it

- Use plain, simple words and short bullets: one idea per bullet, about 20 words at most.
- **Bold** the key terms a student must be able to recall.
- Definitions go on one bullet: `**Term**: meaning`, using the wording from the material.
- Put each formula on its own bullet inside backticks, using plain text and Unicode symbols (², √, π, Δ, ≤, →), never LaTeX. On the next bullet, say what each symbol means.
- Use a table to compare two or more things (differences, types, properties, pros and cons).
- Use a numbered list for steps, processes and sequences.
- For diagrams, charts and pictures, describe what they show in 1–3 bullets.
- Where it helps something stick, add a memory hook (mnemonic, acronym, rhyme or simple analogy) as a bullet starting with `💡 Memory hook:`. Never invent facts in a hook.

## Diagrams

When a process, cycle or classification is easier to see than to read, draw it as a `diagram` code block in one of these forms:

```diagram
type: flow
title: How a bill becomes law
- Bill is introduced
- Both houses pass it
- President signs it
```

- `flow`: steps in order, top to bottom (2–8 steps).
- `cycle`: steps where the last one leads back to the first (3–8 steps).
- `tree`: a classification. Indent each level by two more spaces (up to 3 levels and 15 items).

Keep each item under 8 words, and use only facts from the material. Draw at most one diagram per section.

## Structure

1. `# Title`: the subject or topic of the material.
2. One `## Section` per main topic, in the order of the material. Inside a section use bullets, `### Subsections`, tables, numbered steps and diagrams as needed.
3. End every section with a short must-remember list, written as a quote block:

   ```markdown
   > **Must remember**
   > - the 3–5 most exam-worthy points of this section
   ```

4. Finish with `## One-page revision sheet`: the whole material squeezed onto one printed page. Use very short bullets with the key terms, formulas and facts, grouped by section.

## Output

- Output only the handbook in Markdown: no greeting, preamble or closing remarks.
- Use only headings, bullets, numbered lists, bold, italics, tables, quote blocks, `code` and `diagram` blocks. No HTML tags, LaTeX, images or links (unless the material contains the link).
- If the material has no readable study content (blank pages, an unreadable scan or photo, or not study material), reply with exactly one line: `NO_CONTENT_FOUND: <short reason>`.
