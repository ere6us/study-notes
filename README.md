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

## Changing the notes style (owner)

Gemini follows the instructions in two files, which the app loads every time:

- [`skills/handbook/SKILL.md`](skills/handbook/SKILL.md) for **Handbook**
- [`skills/explain/SKILL.md`](skills/explain/SKILL.md) for **Explain simply**

Edit them on GitHub and commit; the next handbook uses the new style once GitHub Pages updates (usually a minute or two). Keep the `---` header at the top: the app sends everything below it. Both describe the small diagram syntax (flow, cycle, tree) that the app draws.

They are also standard Agent Skills: copy a folder such as `skills/handbook` into `~/.claude/skills/` (Claude Code) or `~/.copilot/skills/` (GitHub Copilot) to use the same style there.

The models are listed at the top of [`gemini.js`](gemini.js): `gemini-3.8-flash`, then `gemini-3.6-flash`, then `gemini-3.5-flash-lite`, all on the free plan. `gemini-flash-latest` is tried only if all three are retired.

[`pptx.js`](pptx.js) reads a .pptx on its own, without the rest of the page: `readPptx(file)` returns the slides in presentation order with their text and downscaled pictures.

## Privacy

There is no server. The key is stored only in the student's browser (localStorage) and is sent only to Google. Files go straight from the phone to the Gemini API. On the free plan, Google may use what is sent to improve its products, so don't upload anything private.

## Tests

The Playwright tests in [`tests/`](tests) run in WebKit with iPhone 12 emulation against a mocked Gemini API: every input type, both modes, the diagrams, the free-model fallback, every error message, and model output full of malicious HTML. GitHub Actions runs them on every push and uploads screenshots of every screen as the `screenshots` artifact. To run them locally:

```sh
cd tests
npm install
npx playwright install webkit
npx playwright test
```
