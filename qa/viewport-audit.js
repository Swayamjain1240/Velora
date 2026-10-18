'use strict';

// Standalone one-viewport audit. Mirrors e2e/viewports.spec.js but reports every
// measurement instead of failing on the first one, and retries a route once if
// the app transiently lands on /login (the known OBS-001 symptom).
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(path.join(process.cwd(), 'node_modules/@playwright/test'));

const SIZES = [
  { name: 'desktop 1440x900', width: 1440, height: 900 },
  { name: 'tablet 768x1024', width: 768, height: 1024 },
  { name: 'mobile 390x844', width: 390, height: 844 },
  { name: 'small 320x568', width: 320, height: 568 },
  { name: 'landscape 844x390', width: 844, height: 390 },
  { name: 'short 320x400', width: 320, height: 400 },
];

const SESSIONS = [
  {
    file: 'viewport-reviewer.json',
    routes: ['/app', '/app/patients', '/app/episodes', '/app/queues', '/app/metrics', '/app/privacy', '/app/profile'],
  },
  {
    file: 'viewport-admin.json',
    routes: ['/app', '/app/clinic', '/app/audit', '/app/retention', '/app/privacy', '/app/metrics', '/app/profile'],
  },
  { file: 'docs-coordinator.json', routes: ['/app', '/app/patients', '/app/episodes', '/app/profile'] },
  { file: 'docs-patient.json', routes: ['/app', '/app/me/episodes', '/app/me', '/app/me/care'] },
  { file: 'docs-caregiver.json', routes: ['/app', '/app/caregiver'] },
];

const BASE = process.env.AUDIT_BASE || 'http://localhost:5173';

async function measure(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    return {
      scrollHeight: doc.scrollHeight,
      innerHeight: window.innerHeight,
      scrollWidth: doc.scrollWidth,
      innerWidth: window.innerWidth,
      bodyOverflowY: getComputedStyle(body).overflowY,
      bodyScrollHeight: body.scrollHeight,
    };
  });
}

(async () => {
  const browser = await chromium.launch();
  const failures = [];
  let checks = 0;

  for (const size of SIZES) {
    for (const session of SESSIONS) {
      const state = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'e2e/.auth', session.file), 'utf8'));
      const context = await browser.newContext({ storageState: state, viewport: { width: size.width, height: size.height } });
      const page = await context.newPage();

      for (const route of session.routes) {
        checks += 1;
        let ok = false;
        for (let attempt = 0; attempt < 2 && !ok; attempt += 1) {
          await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
          try {
            await page.getByRole('navigation', { name: 'Application' }).waitFor({ state: 'visible', timeout: 8000 });
            ok = true;
          } catch {
            await page.waitForTimeout(400);
          }
        }
        if (!ok) {
          failures.push(`${size.name} ${session.file} ${route}: never rendered the shell (url ${new URL(page.url()).pathname})`);
          continue;
        }

        // Settle one paint: Vite injects the stylesheet through JS in dev, so a
        // measurement in the very first frame can read layout before the styles
        // that make .panel-scroll a scroll container have been applied.
        await page.waitForTimeout(250);
        const m = await measure(page);
        const vOverflow = m.scrollHeight - m.innerHeight;
        const hOverflow = m.scrollWidth - m.innerWidth;
        if (vOverflow > 2) failures.push(`${size.name} ${session.file} ${route}: vertical overflow ${vOverflow}px`);
        if (hOverflow > 2) failures.push(`${size.name} ${session.file} ${route}: horizontal overflow ${hOverflow}px`);
        if (m.bodyScrollHeight > m.innerHeight + 1 && m.bodyOverflowY === 'hidden') {
          failures.push(`${size.name} ${session.file} ${route}: clipped by overflow:hidden`);
        }
        const signOut = await page.getByRole('button', { name: 'Sign out', exact: true }).isVisible();
        if (!signOut) failures.push(`${size.name} ${session.file} ${route}: Sign out not visible`);
        const pane = await page.evaluate(() => {
          const main = document.querySelector('.shell__main');
          if (!main) return null;
          const card = document.querySelector('.card');
          const wide = [];
          main.querySelectorAll('*').forEach((el) => {
            const r = el.getBoundingClientRect();
            let a = el.parentElement;
            let clipped = false;
            while (a && a !== main) {
              if (getComputedStyle(a).overflowX !== 'visible') { clipped = true; break; }
              a = a.parentElement;
            }
            if (r.right > main.getBoundingClientRect().right + 2 && !clipped) {
              wide.push(`${el.tagName}.${String(el.className).slice(0, 28)} w=${Math.round(r.width)}`);
            }
          });
          return {
            sw: main.scrollWidth,
            cw: main.clientWidth,
            cardW: card ? Math.round(card.getBoundingClientRect().width) : -1,
            wide: wide.slice(0, 5),
          };
        });
        if (pane && pane.sw > pane.cw + 2) {
          failures.push(`${size.name} ${session.file} ${route}: main pane scrolls horizontally ${JSON.stringify(pane)}`);
        }
      }
      await context.close();
    }
    process.stdout.write(`[audit] ${size.name} done\n`);
  }

  await browser.close();
  process.stdout.write(`\n${checks} route checks, ${failures.length} failure(s)\n`);
  failures.forEach((f) => process.stdout.write(`  FAIL ${f}\n`));
  process.exit(failures.length ? 1 : 0);
})().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exit(2);
});
