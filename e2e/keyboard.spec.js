'use strict';

// Keyboard-only journeys for the two interactive patterns a Tab walk cannot
// prove: a modal dialog and a tab strip.
//
// The unit suites already assert both against jsdom. This spec drives a real
// layout engine, because focus management depends on the browser's own
// sequential-focus model - exactly the layer jsdom does not implement.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

function session(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '.auth', file), 'utf8'));
}

const inDialog = () =>
  document.activeElement
    ? Boolean(document.activeElement.closest('[role="dialog"], [role="alertdialog"]'))
    : false;

test('a dialog traps focus, closes on Escape and returns focus to its trigger', async ({
  browser,
}) => {
  const context = await browser.newContext({
    storageState: session('viewport-reviewer.json'),
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await page.goto('/app/profile');
  await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();

  const trigger = page.getByRole('button', { name: 'Sign out everywhere' }).first();
  await trigger.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('alertdialog', { name: /sign out everywhere/i });
  await expect(dialog).toBeVisible();

  // Focus must already be INSIDE the dialog, not left on the page behind it.
  expect(await page.evaluate(inDialog)).toBe(true);

  // Six forward tabs and two backward must never escape the dialog. More steps
  // than the dialog has controls on purpose: the trap has to wrap.
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('Tab');
    // eslint-disable-next-line no-await-in-loop
    expect(await page.evaluate(inDialog), 'Tab escaped the dialog').toBe(true);
  }
  for (let i = 0; i < 2; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('Shift+Tab');
    // eslint-disable-next-line no-await-in-loop
    expect(await page.evaluate(inDialog), 'Shift+Tab escaped the dialog').toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // Focus restoration: the control that opened it takes focus back, so the
  // keyboard user continues where they were instead of at the top of the page.
  await expect(trigger).toBeFocused();

  await context.close();
});

test('a tab strip is one tab stop and moves with the arrow keys', async ({ browser }) => {
  const context = await browser.newContext({
    storageState: session('docs-coordinator.json'),
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  await page.goto('/app/episodes');
  await expect(page.getByRole('heading', { level: 1, name: 'Episodes' })).toBeVisible();
  await page.getByRole('row', { name: /EP-DOCSDRAFT/ }).getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'EP-DOCSDRAFT' })).toBeVisible();

  const strip = page.getByRole('tablist', { name: 'Episode sections' });
  const tabs = strip.getByRole('tab');

  // Exactly one tab stop in the whole strip.
  const tabStops = await strip.locator('[role="tab"][tabindex="0"]').count();
  expect(tabStops).toBe(1);

  const overview = strip.getByRole('tab', { name: 'Overview', exact: true });
  await overview.focus();
  await page.keyboard.press('ArrowRight');
  await expect(strip.getByRole('tab', { name: 'Plan', exact: true })).toBeFocused();
  await expect(strip.getByRole('tab', { name: 'Plan', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );

  await page.keyboard.press('End');
  await expect(strip.getByRole('tab', { name: 'Closure', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(overview).toBeFocused();

  // Wrapping: left from the first tab lands on the last.
  await page.keyboard.press('ArrowLeft');
  await expect(strip.getByRole('tab', { name: 'Closure', exact: true })).toBeFocused();

  // The strip is still a single Tab stop after arrowing around.
  expect(await strip.locator('[role="tab"][tabindex="0"]').count()).toBe(1);
  expect(await tabs.count()).toBeGreaterThan(1);

  await context.close();
});
