'use strict';

// L11: a CI-gated layout regression check.
//
// Pixel-diff baselines are brittle across operating systems and font stacks, so
// this gate compares the numbers a layout regression actually moves: page
// overflow in both axes, the main region's box, the number of stacked tables,
// and the visible heading. The measurements are exact integers, the tolerance is
// small, and the baseline is committed next to this script.
//
//   node qa/layout-snapshot.js            compare against qa/baselines/layout.json
//   node qa/layout-snapshot.js --update   rewrite the baseline (deliberate change)
//
// Requires the stack from `npm run dev` plus the enrolled sessions written by
// the Playwright global setup (e2e/.auth). In CI it runs after the browser
// journeys, which produce those sessions.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.cwd() + '/node_modules/@playwright/test');

const BASE = process.env.E2E_BASE_URL || 'http://localhost:5173';
const AUTH = path.join(process.cwd(), 'e2e', '.auth');
const BASELINE = path.join(process.cwd(), 'qa', 'baselines', 'layout.json');
// Text metrics differ between operating systems, and the landing page is the one
// screen allowed to scroll, so its height has the loosest bound. Fixed-shell
// screens are held to a couple of pixels.
const TOLERANCE = 2;
const TOLERANCE_BY_ROUTE = { landing: 120 };
// L16 note: `mainWidth` used to carry a 32 px allowance at phone widths because
// the number followed the screen's MIN-CONTENT width, and Windows (Segoe UI) and
// Linux (Liberation Sans) disagreed by ~20 px. That allowance was accommodating
// the defect. `main` is now a `minmax(0, 1fr)` column of the fixed shell, so it
// equals the viewport at every width and the font cannot move it; the allowance
// is gone and a real width regression now fails at any size.

const SIZES = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'short-phone', width: 320, height: 400 },
];

const ROUTES = [
  { name: 'landing', url: '/', auth: null },
  { name: 'login', url: '/login', auth: null },
  { name: 'dashboard', url: '/app', auth: 'viewport-reviewer.json' },
  { name: 'patients', url: '/app/patients', auth: 'viewport-reviewer.json' },
  { name: 'episodes', url: '/app/episodes', auth: 'viewport-reviewer.json' },
  { name: 'metrics', url: '/app/metrics', auth: 'viewport-reviewer.json' },
  { name: 'clinic', url: '/app/clinic', auth: 'viewport-admin.json' },
  { name: 'audit', url: '/app/audit', auth: 'viewport-admin.json' },
  { name: 'retention', url: '/app/retention', auth: 'viewport-admin.json' },
];


function readAuth(file) {
  if (!file) return undefined;
  const full = path.join(AUTH, file);
  if (!fs.existsSync(full)) {
    throw new Error(`missing ${full}; run the Playwright global setup first`);
  }
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

async function measure(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const main = document.querySelector('main') || document.body;
    const box = main.getBoundingClientRect();
    const heading = document.querySelector('h1');
    const nav = document.querySelector('nav[aria-label="Application"]');
    return {
      overflowX: Math.max(0, doc.scrollWidth - window.innerWidth),
      overflowY: Math.max(0, doc.scrollHeight - window.innerHeight),
      mainWidth: Math.round(box.width),
      heading: heading ? heading.textContent.trim().slice(0, 80) : null,
      tables: document.querySelectorAll('.table--stack').length,
      cards: document.querySelectorAll('.record-card:not(.record-card--empty)').length,
      navLinks: nav ? nav.querySelectorAll('a').length : 0,
    };
  });
}

(async () => {
  const update = process.argv.includes('--update');
  const browser = await chromium.launch();
  const snapshot = {};

  for (const route of ROUTES) {
    for (const size of SIZES) {
      const auth = readAuth(route.auth);
      // eslint-disable-next-line no-await-in-loop
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        storageState: auth,
      });
      // eslint-disable-next-line no-await-in-loop
      const page = await context.newPage();
      // eslint-disable-next-line no-await-in-loop
      await page.goto(`${BASE}${route.url}`, { waitUntil: 'networkidle' });
      // eslint-disable-next-line no-await-in-loop
      await page.waitForSelector('h1', { timeout: 15_000 });
      if (route.name === 'metrics') {
        // The table-bearing panel, so the stacked-table count is stable.
        // eslint-disable-next-line no-await-in-loop
        await page.getByRole('tab', { name: /queue age/i }).click();
        // eslint-disable-next-line no-await-in-loop
        await page.waitForTimeout(150);
      }
      // eslint-disable-next-line no-await-in-loop
      await page.waitForTimeout(200);
      // eslint-disable-next-line no-await-in-loop
      const values = await measure(page);
      snapshot[`${route.name}@${size.name}`] = { ...values, tolerance: TOLERANCE_BY_ROUTE[route.name] || TOLERANCE };
      // eslint-disable-next-line no-await-in-loop
      await context.close();
    }
  }

  await browser.close();

  if (update) {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, `${JSON.stringify(snapshot, null, 2)}\n`);
    process.stdout.write(`layout baseline written: ${Object.keys(snapshot).length} snapshots\n`);
    return;
  }

  if (!fs.existsSync(BASELINE)) {
    throw new Error('no layout baseline; run with --update once and commit the result');
  }
  const expected = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const failures = [];
  for (const [key, actual] of Object.entries(snapshot)) {
    const want = expected[key];
    if (!want) {
      failures.push(`${key}: not in the baseline (new route/size?)`);
      continue;
    }
    const tolerance = actual.tolerance ?? TOLERANCE;
    for (const [field, actualValue] of Object.entries(actual)) {
      if (field === 'tolerance') continue;
      const expectedValue = want[field];
      const fieldTolerance = tolerance;
      if (typeof actualValue === 'number' && typeof expectedValue === 'number') {
        if (Math.abs(actualValue - expectedValue) > fieldTolerance) {
          failures.push(
            `${key}.${field}: ${actualValue} (baseline ${expectedValue}, ±${fieldTolerance})`
          );
        }
      } else if (actualValue !== expectedValue) {
        failures.push(`${key}.${field}: ${JSON.stringify(actualValue)} (baseline ${JSON.stringify(expectedValue)})`);
      }
    }
  }
  for (const key of Object.keys(expected)) {
    if (!snapshot[key]) failures.push(`${key}: missing from this run`);
  }

  if (failures.length) {
    process.stderr.write(`layout snapshot: ${failures.length} difference(s)\n`);
    failures.forEach((line) => process.stderr.write(`  ${line}\n`));
    process.stderr.write('Review the change; if it is intended, re-run with --update.\n');
    process.exit(1);
  }
  process.stdout.write(`layout snapshot: ${Object.keys(snapshot).length} surfaces match the baseline\n`);
})().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exit(2);
});
