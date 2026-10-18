'use strict';

// Capture the stage-1 surfaces and the 3D hero for the visual-regression report.
// WebGL is enabled in headless Chromium through SwiftShader, so the real scene
// is captured; a second context disables WebGL to capture the static fallback.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.cwd() + '/node_modules/@playwright/test');

const OUT = path.join(process.cwd(), 'docs/assets/ui-stage1');
const BASE = process.env.BASE || 'http://localhost:5173';
const SIZES = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '390x844', width: 390, height: 844 },
  { name: '320x568', width: 320, height: 568 },
  { name: '844x390', width: 844, height: 390 },
  { name: '320x400', width: 320, height: 400 },
];

async function measure(page) {
  return page.evaluate(() => {
    const hero = document.querySelector('.hero-visual');
    const content = document.querySelector('.landing__hero-content');
    const link = document.querySelector('.landing__hero a');
    const canvas = document.querySelector('canvas');
    const rect = (el) => (el ? el.getBoundingClientRect().toJSON() : null);
    return {
      canvas: Boolean(canvas),
      hero: rect(hero),
      content: rect(content),
      link: rect(link),
      docScrollHeight: document.documentElement.scrollHeight,
      docScrollWidth: document.documentElement.scrollWidth,
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
      heroScrollHeight: document.querySelector('.landing__hero')?.scrollHeight ?? null,
    };
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const report = [];

  for (const size of SIZES) {
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2600);
    const metrics = await measure(page);
    await page.screenshot({ path: path.join(OUT, `landing-${size.name}.png`) });

    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const login = await page.evaluate(() => {
      const panel = document.querySelector('.panel');
      const submit = document.querySelector('button[type="submit"]');
      return {
        panel: panel ? panel.getBoundingClientRect().toJSON() : null,
        submitVisible: submit ? submit.getBoundingClientRect().bottom <= window.innerHeight + 1 : false,
        docScrollHeight: document.documentElement.scrollHeight,
        innerHeight: window.innerHeight,
        docScrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      };
    });
    await page.screenshot({ path: path.join(OUT, `login-${size.name}.png`) });

    report.push({ size: size.name, ...metrics, login, errors });
    await context.close();
  }

  // Static fallback: WebGL denied by the browser.
  const noGl = await chromium.launch({ args: ['--disable-webgl', '--disable-webgl2'] });
  const fallbackContext = await noGl.newContext({ viewport: { width: 1440, height: 900 } });
  const fallbackPage = await fallbackContext.newPage();
  await fallbackPage.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await fallbackPage.waitForTimeout(900);
  await fallbackPage.screenshot({ path: path.join(OUT, 'landing-1440x900-no-webgl.png') });
  report.push({ size: '1440x900 no-webgl', fallback: await measure(fallbackPage) });
  await noGl.close();

  // Reduced motion at desktop size.
  const rmContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  });
  const rmPage = await rmContext.newPage();
  await rmPage.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await rmPage.waitForTimeout(1600);
  await rmPage.screenshot({ path: path.join(OUT, 'landing-1440x900-reduced-motion.png') });
  report.push({
    size: '1440x900 reduced-motion',
    reduced: await rmPage.evaluate(() => ({
      canvas: Boolean(document.querySelector('canvas')),
      inlineStyle: document.querySelector('.landing__hero-content')?.getAttribute('style') || null,
    })),
  });
  await rmContext.close();

  await browser.close();
  fs.writeFileSync(path.join(OUT, 'measurements.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2));
})().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exit(2);
});
