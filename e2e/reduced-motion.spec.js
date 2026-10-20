'use strict';

// L13: prefers-reduced-motion in a REAL browser engine.
//
// The unit suite proves the hero host passes `frameloop: 'demand'` when the
// media query matches, but jsdom cannot prove what the page actually renders.
// This spec drives Chromium with the preference emulated and asserts the two
// things a user with vestibular sensitivity would feel:
//
//  1. a route change does not fade/slide the content in (the page-transition
//     tween is skipped, so no inline opacity/transform is ever applied), and
//  2. the landing page is fully legible with the decorative scene not animating
//     on its own (the host stays aria-hidden and the CSS motion is neutralised).
//
// It intentionally makes NO claim about the canvas frame loop, which is not
// observable from the DOM: that is covered by the unit test on the host's
// props.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

function session(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '.auth', file), 'utf8'));
}

test('routing does not animate the page when reduced motion is requested', async ({ browser }) => {
  const context = await browser.newContext({
    storageState: session('viewport-reviewer.json'),
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await page.goto('/app');
  await expect(page.getByRole('navigation', { name: 'Application' })).toBeVisible();

  // The preference really is active in this renderer, so a pass cannot come
  // from the browser ignoring the emulation.
  const reduced = await page.evaluate(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  expect(reduced).toBe(true);

  // Navigate by keyboard-activating a real navigation link, then sample the
  // transition wrapper repeatedly. With the tween skipped it never carries an
  // inline opacity below 1; an animating build would show 0.6 -> 1 over ~240 ms.
  await page.getByRole('navigation', { name: 'Application' }).getByRole('link').first().click();
  const samples = [];
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    samples.push(
      // eslint-disable-next-line no-await-in-loop
      await page.evaluate(() => {
        const el = document.querySelector('.shell__transition');
        if (!el) return null;
        return {
          opacity: el.style.opacity,
          transform: el.style.transform,
        };
      })
    );
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(20);
  }

  for (const sample of samples) {
    if (!sample) continue;
    // An empty inline opacity is the reduced-motion path (clearProps); an
    // explicit "1" is equally static. Anything between is a tween that should
    // not have run.
    if (sample.opacity !== '' && sample.opacity !== '1') {
      throw new Error(
        `content was mid-animation under reduced motion: ${JSON.stringify(samples)}`
      );
    }
    expect(sample.transform === '' || sample.transform === 'none').toBe(true);
  }

  await context.close();
});

test('the landing page stays legible and static under reduced motion', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Velora' })).toBeVisible();

  // The decorative scene conveys nothing, so it must stay out of the
  // accessibility tree, and the CSS layer must not run its entry animations.
  const state = await page.evaluate(() => {
    const host = document.querySelector('.hero-visual');
    const animated = [...document.querySelectorAll('main *')].filter((el) => {
      const style = getComputedStyle(el);
      return style.animationName !== 'none' && parseFloat(style.animationDuration) > 0.05;
    });
    // Durations are compared as NUMBERS in milliseconds: Chromium serialises
    // the clamped 0.001ms as "1e-06s", so matching a string list would test the
    // engine's serialisation instead of the clamp.
    const toMs = (value) => {
      const text = String(value || '0s').trim();
      if (text.endsWith('ms')) return parseFloat(text);
      if (text.endsWith('s')) return parseFloat(text) * 1000;
      return Number(text) * 1000;
    };
    return {
      hostHidden: host ? host.getAttribute('aria-hidden') : null,
      animationDurationMs: host ? toMs(getComputedStyle(host).animationDuration) : null,
      animatedCount: animated.length,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
    };
  });

  expect(state.hostHidden).toBe('true');
  // The global reduced-motion rule clamps every animation to ~0.001ms (1e-06s).
  expect(state.animationDurationMs).toBeLessThanOrEqual(1);
  expect(state.animatedCount).toBe(0);
  expect(state.overflowX).toBeLessThanOrEqual(2);

  await context.close();
});
