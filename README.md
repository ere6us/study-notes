# study-notes

Handbook Maker turns class notes, teachers' PowerPoint slides and photos of notes into a simple bullet-point handbook to revise from, or into a step-by-step explanation. It runs in the browser on GitHub Pages and uses Google's Gemini API on the free plan only.

**Open it:** https://ere6us.github.io/study-notes/

## Student setup (iPhone)

1. Open https://ere6us.github.io/study-notes/ in **Safari**.
2. Get a free Gemini API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey): sign in with Google, tap **Create API key**, and copy it. No card or billing is needed, so skip any billing or upgrade prompts.
3. Paste the key into the page and tap **Save key**. You only do this once.
4. Optional: open Safari's Share menu and tap **Add to Home Screen**. If you see **Open as Web App** (iOS 26 and later), turn it off. iPhones can't print from Home Screen web apps, so Save as PDF and Share wouldn't work there.

## Using it

1. Pick what you need: **Handbook** (short notes to memorize) or **Explain simply** (step by step, to understand).
2. Tap **Choose PDF or slides** for a PDF or a PowerPoint file (.pptx), or **Use photos** to pick or take photos of textbook pages, diagrams, whiteboards or handwritten notes.
3. Keep the screen open and on while it works; long files take a few minutes.
4. Tap **Save as PDF**, then on the print screen tap the Share icon at the top and choose **Save to Files**. Or tap **Share** and pick WhatsApp, Mail, AirDrop or another app.

Limits:

- PDFs: up to 50 MB and 1,000 pages. Big PDFs are uploaded to Google first (they delete themselves after 48 hours; the app deletes them as soon as it's done).
- PowerPoint (.pptx): read on the phone, with each slide's text, tables, chart data, SmartArt, speaker notes and pictures (pictures are shrunk to at most 1600 px). Old .ppt, Keynote and Google Slides files need one export to .pptx or PDF.
- Photos: up to 30 at a time, shrunk on the phone to at most 2048 px.
- The free plan has a daily limit for each model. When the main model's limit is used up, the app uses Google's next free model and says so. Limits reset at midnight Pacific time; the app shows that time in your own time zone.

When something goes wrong, the app says what happened in plain words and what to do next, with a short code in small print (for example `Code: LIMIT_DAY`) that helps the site owner.

## Asking questions

In a handbook, long-press a word and drag to select the passage you're stuck on, then tap **Ask about this** at the bottom of the screen. Type a question, or tap **Explain simply**, **Give an example**, **Memory trick** or **Draw a diagram**. The answer appears in a pink "You asked" box right under that passage, usually within a few seconds, because only the handbook's text is sent, never the original file. Answers are saved with the handbook, so they're still there after Safari is closed, and they're included in Save as PDF and Share. Tap **×** on a box to remove it.

Gemini answers from the handbook, and starts anything that goes beyond your notes with "Beyond your notes:". Questions use the free models in the opposite order to handbooks (`gemini-3.5-flash-lite` first), so they draw on the lighter model's own daily allowance.

## Changing the notes style (owner)

Gemini follows the instructions in three files, which the app loads every time:

- [`skills/handbook/SKILL.md`](skills/handbook/SKILL.md) for **Handbook**
- [`skills/explain/SKILL.md`](skills/explain/SKILL.md) for **Explain simply**
- [`skills/ask/SKILL.md`](skills/ask/SKILL.md) for answers to questions about a passage

Edit them on GitHub and commit; the next handbook or answer uses the new style once GitHub Pages updates (usually a minute or two). Keep the `---` header at the top: the app sends everything below it. All three describe the small diagram syntax (flow, cycle, tree) that the app draws.

They are also standard Agent Skills: copy a folder such as `skills/handbook` into `~/.claude/skills/` (Claude Code) or `~/.copilot/skills/` (GitHub Copilot) to use the same style there.

The models are listed at the top of [`gemini.js`](gemini.js): handbooks use `gemini-3.8-flash`, then `gemini-3.6-flash`, then `gemini-3.5-flash-lite`, all on the free plan, and questions use the same three the other way round. `gemini-flash-latest` is tried only if all three are retired.

[`pptx.js`](pptx.js) reads a .pptx on its own, without the rest of the page: `readPptx(file)` returns the slides in presentation order with their text and downscaled pictures.

## Waiting messages (owner)

While Gemini works, a short love note sits under the status. It changes every 7 seconds, and each full minute brings a "still waiting" line with the time. The lines are in [`love-notes.md`](love-notes.md): each `##` heading is a stage (Getting ready, Sending, Reading, Planning, Writing, Still waiting, and Answering for questions) and each `-` bullet is one line. `{thing}` becomes "handbook" or "explanation", and `{time}` becomes "1 minute", "2 minutes" and so on. Edit it on GitHub; the next run uses the new lines. A line doesn't come back until every other line of its stage has been shown, even on later visits.

## Privacy

There is no server. The key is stored only in the student's browser (localStorage) and is sent only to Google. Files go straight from the phone to the Gemini API. On the free plan, Google may use what is sent to improve its products, so don't upload anything private.

## Tests

The Playwright tests in [`tests/`](tests) run in WebKit with iPhone 12 emulation against a mocked Gemini API: every input type, both modes, the diagrams, the waiting messages, questions about a passage, the free-model fallback, every error message, and model output full of malicious HTML. GitHub Actions runs them on every push and uploads screenshots of every screen as the `screenshots` artifact. To run them locally:

```sh
cd tests
npm install
npx playwright install webkit
npx playwright test
```
