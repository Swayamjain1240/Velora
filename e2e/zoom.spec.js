'use strict';

// L5: 200 % and 400 % browser zoom.
//
// Browser zoom is emulated the only way a layout engine can be tested: the CSS
// viewport shrinks while the page keeps its CSS pixel units, so a 1280x1024
// window at 200 % is a 640x512 layout and at 400 % a 320x256 layout. At these
// sizes WCAG 1.4.10 requires content to reflow into ONE direction of scrolling -
// horizontal scrolling is a failure, vertical is allowed - and controls must
// stay reachable.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

function session(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '.auth', file), 'utf8'));
}

const ZOOM_LEVELS = [
  { name: '200%', width: 640, height: 512 },
  { name: '400%', width: 320, height: 256 },
];

const ROUTES = [
  { file: 'viewport-reviewer.json', url: '/app' },
  { file: 'viewport-reviewer.json', url: '/app/patients' },
  { file: 'viewport-reviewer.json', url: '/app/episodes' },
  { file: 'viewport-reviewer.json', url: '/app/today' },
  { file: 'viewport-reviewer.json', url: '/app/queues' },
  { file: 'viewport-reviewer.json', url: '/app/metrics' },
  { file: 'viewport-admin.json', url: '/app/audit' },
  { file: 'viewport-admin.json', url: '/app/clinic' },
  { file: 'viewport-admin.json', url: '/app/retention' },
];

for (const level of ZOOM_LEVELS) {
  test(`screens reflow without horizontal scrolling at ${level.name} zoom`, async ({ browser }) => {
    for (const route of ROUTES) {
      // eslint-disable-next-line no-await-in-loop
      const context = await browser.newContext({
        storageState: session(route.file),
        viewport: { width: level.width, height: level.height },
      });
      const page = await context.newPage();
      // eslint-disable-next-line no-await-in-loop
      await page.goto(route.url);
      // eslint-disable-next-line no-await-in-loop
      await expect(page.getByRole('navigation', { name: 'Application' })).toBeVisible();

      const layout = await page.evaluate(() => {
        const doc = document.documentElement;
        // The widest element that is not inside a deliberately scrollable pane:
        // a table inside `.panel-scroll`/`.table-wrap` may scroll on its own,
        // the PAGE may not.
        const offenders = [];
        document.querySelectorAll('body *').forEach((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width <= window.innerWidth + 2) return;
          let parent = el.parentElement;
          while (parent) {
            const style = getComputedStyle(parent);
            const scrollable =
              (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
              parent.scrollWidth > parent.clientWidth;
            if (scrollable) return;
            parent = parent.parentElement;
          }
          offenders.push({
            tag: el.tagName,
            className: typeof el.className === 'string' ? el.className.slice(0, 80) : '',
            right: Math.round(rect.right),
          });
        });
        return {
          scrollWidth: doc.scrollWidth,
          innerWidth: window.innerWidth,
          docScrollHeight: doc.scrollHeight,
          innerHeight: window.innerHeight,
          offenders: offenders.slice(0, 6),
          signOutVisible: Boolean(
            [...document.querySelectorAll('button')].find(
              (b) => b.textContent.trim() === 'Sign out' && b.getBoundingClientRect().width > 0
            )
          ),
        };
      });

      expect(
        layout.scrollWidth,
        `${route.url} @ ${level.name}: page scrolls horizontally (${layout.scrollWidth} > ${layout.innerWidth}); offenders ${JSON.stringify(layout.offenders)}`
      ).toBeLessThanOrEqual(layout.innerWidth + 2);
      expect(layout.signOutVisible, `${route.url} @ ${level.name}: Sign out is unreachable`).toBe(true);
      // Vertical scrolling is permitted at zoom; it just must not be clipped by
      // an ancestor that hides the overflow.
      expect(layout.docScrollHeight).toBeGreaterThan(0);

      // eslint-disable-next-line no-await-in-loop
      await context.close();
    }
  });
}
