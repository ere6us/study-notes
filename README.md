# study-notes

Handbook Maker turns class-note PDFs and teachers' slides into a simple bullet-point handbook to revise from. It runs in the browser on GitHub Pages and uses Google's Gemini API (free tier).

**Open it:** https://ere6us.github.io/study-notes/

## Student setup (iPhone)

1. Open https://ere6us.github.io/study-notes/ in **Safari**.
2. Get a free Gemini API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey): sign in with Google, tap **Create API key**, and copy it.
3. Paste the key into the page and tap **Save key**. You only do this once.
4. Optional: open Safari's Share menu and tap **Add to Home Screen**. If you see **Open as Web App** (iOS 26 and later), turn it off. iPhones can't print from Home Screen web apps, so Save as PDF wouldn't work there.

To make a handbook, tap **Choose a PDF** and pick the file from Files. Keep the screen open while it works; long PDFs take a few minutes. Then tap **Save as PDF**, tap the Share icon on the print screen, and choose **Save to Files**.

- Export PowerPoint or Keynote slides as PDF first. Gemini takes PDFs up to 50 MB and 1,000 pages; split bigger files.
- Free-tier limits are per Google project and shown in AI Studio. Daily limits reset at midnight Pacific time.
- If the app asks for the key again, paste it again. Safari can clear a site's saved data when you haven't opened it for a while.

## Changing the notes style (owner)

Gemini follows the instructions in [`skills/handbook/SKILL.md`](skills/handbook/SKILL.md). The app loads that file every time it makes a handbook, so edit it on GitHub and commit; the next handbook uses the new style once GitHub Pages updates (usually a minute or two). Keep the `---` header at the top: the app sends everything below it.

The file is also a standard Agent Skill. Copy the `skills/handbook` folder into `~/.claude/skills/` (Claude Code) or `~/.copilot/skills/` (GitHub Copilot) to use the same style there.

The model is set at the top of [`app.js`](app.js): `gemini-3.8-flash`, falling back to `gemini-flash-latest` if Google retires it.

## Privacy

There is no server. The key is stored only in the student's browser (localStorage) and is sent only to Google. PDFs go straight from the phone to the Gemini API. On the free tier, Google may use what is sent to improve its products, so don't upload anything private.

## Tests

The Playwright tests in [`tests/`](tests) run in WebKit with iPhone 12 emulation against a mocked Gemini API, including a response full of malicious HTML. GitHub Actions runs them on every push. To run them locally:

```sh
cd tests
npm install
npx playwright install webkit
npx playwright test
```
