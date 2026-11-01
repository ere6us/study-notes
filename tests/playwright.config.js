// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  timeout: 30_000,
  fullyParallel: true,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173/',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'iPhone 12 (WebKit)', use: { ...devices['iPhone 12'] } }],
  webServer: {
    // Serve the repository root, like GitHub Pages does.
    command: 'python3 -m http.server 4173 --bind 127.0.0.1 --directory ..',
    url: 'http://127.0.0.1:4173/index.html',
    reuseExistingServer: !process.env.CI,
  },
});
