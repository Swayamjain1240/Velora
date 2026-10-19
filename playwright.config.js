'use strict';

// Playwright configuration for Velora's browser journeys.
//
// The stack (API + Vite dev server) is expected to be running before the tests
// start. Locally: `npm run dev`; in CI the workflow starts both and waits for
// health. The client proxies /api to the API, so we drive everything through
// the Vite origin.
const { defineConfig, devices } = require('@playwright/test');

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173';

// Cross-browser coverage (L6). Chromium remains the default gate so a normal
// `npx playwright test` keeps its exact previous behaviour and cost; the other
// engines are opt-in via E2E_PROJECTS:
//   E2E_PROJECTS=firefox,webkit npx playwright test
// CI still installs and runs Chromium only - adding matrix legs is an owner
// decision (see L6). Run each engine as its OWN invocation: the global setup
// re-seeds once per process, so engines sharing one invocation would run against
// a fixture the previous engine already consumed.
const requested = (process.env.E2E_PROJECTS || '')
  .split(',')
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean);

const ALL_PROJECTS = {
  chromium: { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  firefox: { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  webkit: { name: 'webkit', use: { ...devices['Desktop Safari'] } },
};

const projects = requested.length
  ? requested.map((name) => {
      if (!ALL_PROJECTS[name]) {
        throw new Error(`E2E_PROJECTS: unknown browser "${name}" (expected chromium, firefox or webkit)`);
      }
      return ALL_PROJECTS[name];
    })
  : [ALL_PROJECTS.chromium];

// Firefox and WebKit create browsing contexts noticeably slower than Chromium
// (the zoom spec opens nine per test, ~29 s each on Firefox). The assertions are
// unchanged across engines; only the wall-clock budget differs, so a slow engine
// cannot turn a passing layout into a false failure.
const TIMEOUTS = {
  chromium: { timeout: 30_000, expect: 10_000 },
  firefox: { timeout: 120_000, expect: 20_000 },
  webkit: { timeout: 120_000, expect: 20_000 },
};

// The global setup re-seeds and enrols twelve sessions; a slower engine waits on
// the same API, so it gets the matching setup budget too.
const selectedNames = projects.map((p) => p.name);
const slowest = selectedNames.some((n) => n !== 'chromium')
  ? 'firefox'
  : 'chromium';

module.exports = defineConfig({
  testDir: './e2e',
  globalSetup: require.resolve('./e2e/global-setup.js'),
  timeout: TIMEOUTS[slowest].timeout,
  expect: { timeout: TIMEOUTS[slowest].expect },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects,
});
