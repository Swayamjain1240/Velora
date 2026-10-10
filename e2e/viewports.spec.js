'use strict';

// VEL-017 / control #25: every authenticated screen must fit one viewport with
// no page-level vertical scrolling. The enrolled sessions are produced once by
// global-setup, so these tests only measure layout at the six required sizes.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { VIEWPORTS } = require('./helpers');

// Explicit tolerance for sub-pixel rounding in the layout engine.
const TOLERANCE = 2;

function session(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '.auth', file), 'utf8'));
}

// Each session covers the authenticated screens its role can actually reach.
const SESSIONS = [
  { file: 'viewport-reviewer.json', routes: ['/app', '/app/profile'] },
  { file: 'viewport-admin.json', routes: ['/app', '/app/clinic', '/app/profile'] },
];

for (const size of VIEWPORTS) {
  for (const s of SESSIONS) {
    test(`authenticated screens fit one viewport at ${size.name} (${s.file})`, async ({ browser }) => {
      const context = await browser.newContext({
        storageState: session(s.file),
        viewport: { width: size.width, height: size.height },
      });
      const page = await context.newPage();

      for (const route of s.routes) {
        await page.goto(route);
        // Wait for the shell to render before measuring.
        await expect(page.getByRole('navigation', { name: 'Application' })).toBeVisible();

        const metrics = await page.evaluate(() => {
          const doc = document.documentElement;
          const body = document.body;
          return {
            scrollHeight: doc.scrollHeight,
            innerHeight: window.innerHeight,
            bodyScrollHeight: body.scrollHeight,
            // A clipped layout is also a failure: content must not be hidden.
            clipped:
              body.scrollHeight > doc.clientHeight + 1 &&
              getComputedStyle(body).overflowY === 'hidden',
          };
        });

        expect(
          metrics.scrollHeight - metrics.innerHeight,
          `${route} @ ${size.name} overflows the viewport ` +
            `(scrollHeight ${metrics.scrollHeight} > innerHeight ${metrics.innerHeight})`
        ).toBeLessThanOrEqual(TOLERANCE);

        expect(metrics.clipped, `${route} @ ${size.name} clips content with overflow:hidden`).toBe(false);

        // The primary sign-out control must remain reachable at every size.
        await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
      }

      await context.close();
    });
  }
}
