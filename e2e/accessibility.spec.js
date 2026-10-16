'use strict';

// Part 10 item 9: keyboard reachability and visible focus.
//
// What this proves: the authenticated shell can be traversed with the keyboard
// alone, the primary control is reachable within a sane number of steps, the
// focused element SHOWS a focus indicator (an element that accepts focus
// invisibly fails), and keyboard activation really performs an action rather
// than only moving focus.
//
// Activation is exercised on an in-app NAVIGATION link, never on Sign out: the
// enrolled sessions are shared with the viewport and journey specs, so a journey
// that signs the session out would break every later test that reuses it. This
// test therefore performs no state change.
//
// What it does NOT prove (stated so it is never mistaken for a full
// accessibility audit): no screen-reader run, no automated contrast/axe audit,
// no Safari/Firefox run (Chromium only), no physical device, no extreme browser
// zoom, and no keyboard traversal of every screen - only the shell and its
// primary control.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

function session(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '.auth', file), 'utf8'));
}

const FULL = { width: 1440, height: 900 };
// A control that cannot be reached within this many steps is either behind a
// keyboard trap or focusable only by pointer.
const MAX_TABS = 40;

// Reads the focused element and the two properties the assertions need: its
// accessible-ish label and, for links, its destination.
function describeFocus() {
  const el = document.activeElement;
  if (!el) return null;
  const style = getComputedStyle(el);
  return {
    tag: el.tagName,
    href: el.getAttribute('href'),
    label: (el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 40),
    outlineStyle: style.outlineStyle,
    outlineWidth: style.outlineWidth,
    boxShadow: style.boxShadow,
  };
}

test('the shell is keyboard-reachable, shows focus, and activates a control without a pointer', async ({
  browser,
}) => {
  const context = await browser.newContext({
    storageState: session('viewport-reviewer.json'),
    viewport: FULL,
  });
  const page = await context.newPage();
  await page.goto('/app');
  await expect(page.getByRole('navigation', { name: 'Application' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();

  // ---- keyboard ACTIVATION --------------------------------------------------
  // Tab until an in-app navigation link holds focus, then activate it with Enter
  // and require the route to change.
  let activation = null;
  for (let step = 0; step < MAX_TABS && !activation; step += 1) {
    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('Tab');
    // eslint-disable-next-line no-await-in-loop
    const focus = await page.evaluate(describeFocus);
    if (focus && focus.tag === 'A' && focus.href && focus.href.startsWith('/app')) {
      const destination = focus.href;
      // eslint-disable-next-line no-await-in-loop
      await page.keyboard.press('Enter');
      // eslint-disable-next-line no-await-in-loop
      await expect
        .poll(() => new URL(page.url()).pathname, {
          message: `Enter on the link to ${destination} did not change the route`,
        })
        .toBe(destination);
      activation = { label: focus.label, destination };
      // Return to the shell so the reachability pass below starts from the same
      // place, then wait for it to render again.
      // eslint-disable-next-line no-await-in-loop
      await page.goto('/app');
      // eslint-disable-next-line no-await-in-loop
      await expect(page.getByRole('navigation', { name: 'Application' })).toBeVisible();
    }
  }
  expect(activation, `no in-app link was keyboard-reachable within ${MAX_TABS} tabs`).not.toBeNull();

  // ---- reachability + visible focus of the primary control ------------------
  const focusOrder = [];
  let reached = false;
  for (let step = 0; step < MAX_TABS && !reached; step += 1) {
    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('Tab');
    // eslint-disable-next-line no-await-in-loop
    const focus = await page.evaluate(describeFocus);
    if (!focus) break;
    focusOrder.push(focus);
    reached = focus.label === 'Sign out';
  }
  expect(
    reached,
    `Sign out was not keyboard-reachable within ${MAX_TABS} tabs. Focus order: ${focusOrder
      .map((f) => f.label)
      .join(' -> ')}`
  ).toBe(true);

  // The element that holds focus must SHOW it: an outline of at least 2px, or a
  // ring drawn with box-shadow. Invisible focus is a failure.
  const last = focusOrder[focusOrder.length - 1];
  const outlined = last.outlineStyle !== 'none' && parseFloat(last.outlineWidth) >= 2;
  const ringed = Boolean(last.boxShadow) && last.boxShadow !== 'none';
  expect(
    outlined || ringed,
    `the focused control shows no focus indicator: ${JSON.stringify(last)}`
  ).toBe(true);

  // Deliberately no sign-out: these sessions are shared with the other specs.
  await context.close();
});
