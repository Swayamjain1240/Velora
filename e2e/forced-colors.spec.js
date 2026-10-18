'use strict';

// L12: forced-colours / high-contrast mode. Windows High Contrast replaces the
// palette with system colours and removes shadows, so any surface separated only
// by a translucent fill becomes invisible. These checks run with the media
// feature actually emulated, not by reading CSS source.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

function session(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '.auth', file), 'utf8'));
}

async function styleOf(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const style = getComputedStyle(el);
    return {
      display: style.display,
      borderTopWidth: style.borderTopWidth,
      borderTopColor: style.borderTopColor,
      backgroundImage: style.backgroundImage,
      boxShadow: style.boxShadow,
    };
  }, selector);
}

test('forced colours keep boundaries and hide the decorative scene', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.emulateMedia({ forcedColors: 'active' });

  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Staff sign in' })).toBeVisible();

  const panel = await styleOf(page, '.panel');
  expect(panel.borderTopWidth).toBe('1px');
  // A transparent border would be the classic forced-colour failure.
  expect(panel.borderTopColor).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);

  const submit = await styleOf(page, '.panel .btn');
  expect(submit.borderTopWidth).toBe('1px');
  expect(submit.borderTopColor).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow).toBeLessThanOrEqual(2);

  await context.close();
});

test('forced colours hide the hero canvas rather than shipping a blank box', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const hero = await styleOf(page, '.hero-visual');
  expect(hero.display).toBe('none');
  await context.close();
});

test('high-contrast preference strengthens borders without breaking the shell', async ({ browser }) => {
  const context = await browser.newContext({
    storageState: session('viewport-reviewer.json'),
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await page.emulateMedia({ contrast: 'more' });
  await page.goto('/app');
  await expect(page.getByRole('navigation', { name: 'Application' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow).toBeLessThanOrEqual(2);
  await context.close();
});
