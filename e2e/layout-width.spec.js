'use strict';

// L16 regression: the ADMIN WIDTH defect, generalised to every authenticated
// screen at all six required viewport sizes.
//
// The defect the old checks could not see: `document.scrollWidth` always equalled
// the viewport because `body` is `overflow-x: hidden`, so the shell's oversized
// content was CLIPPED, not scrolled, and reported as perfect. The numbers that
// actually moved were `main`'s box (412 px at a 390 px phone, 384 px at 320 px)
// and the content inside it.
//
// This spec measures the real boxes:
//   1. the document must not be wider than the viewport;
//   2. `main` must fit the viewport (its width AND its right edge);
//   3. `main` must not scroll horizontally itself (content must reflow, not hide);
//   4. no visible element may sit past the viewport's right edge;
//   5. every tab strip must show all of its tabs (no invisible scrollbar hiding
//      destinations - the queue strip used to hide 455 px of tabs at 320 px).
//
// The stacked table's `<thead>` is excluded on purpose: it is visually hidden but
// kept in the accessibility tree, so its cells legitimately sit outside the box.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { VIEWPORTS } = require('./helpers');

// Sub-pixel rounding only. This is a layout assertion, not a tolerance knob.
const TOLERANCE = 1;

function session(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '.auth', file), 'utf8'));
}

// Every authenticated surface a role can reach, grouped by the enrolled session
// that can open it.
const SURFACES = [
  {
    file: 'viewport-admin.json',
    routes: [
      '/app',
      '/app/clinic',
      '/app/audit',
      '/app/retention',
      '/app/privacy',
      '/app/metrics',
      '/app/profile',
    ],
  },
  {
    file: 'viewport-reviewer.json',
    routes: [
      '/app',
      '/app/patients',
      '/app/episodes',
      '/app/queues',
      '/app/metrics',
      '/app/privacy',
      '/app/profile',
    ],
  },
  {
    file: 'docs-patient.json',
    routes: ['/app', '/app/me', '/app/me/episodes', '/app/me/care', '/app/today'],
  },
  {
    file: 'docs-caregiver.json',
    routes: ['/app', '/app/caregiver', '/app/today'],
  },
];

// Returns the layout facts the assertions below need, plus the first offending
// element (tag + text) so a failure names the thing that is too wide.
async function measureWidths(page) {
  return page.evaluate(() => {
    const viewport = window.innerWidth;
    const doc = document.documentElement;
    const main = document.querySelector('main');
    const box = main.getBoundingClientRect();

    let widest = null;
    for (const el of document.querySelectorAll('main *')) {
      // The visually hidden header of a stacked table is not visible content.
      if (el.closest('.table--stack thead')) continue;
      // A `.panel-scroll` is Velora's one sanctioned bounded scroll region: above
      // the 720 px stacking breakpoint a six-column table scrolls inside it (the
      // tablet test below asserts that contract). Everything else must reflow.
      if (el.closest('.panel-scroll')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.right <= viewport + 1) continue;
      if (!widest || rect.right > widest.right) {
        widest = {
          tag: el.tagName,
          cls: typeof el.className === 'string' ? el.className : '',
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          text: (el.textContent || '').trim().slice(0, 60),
        };
      }
    }

    const hiddenTabs = [...document.querySelectorAll('.tabs')]
      .map((el) => ({
        label: el.getAttribute('aria-label'),
        hidden: Math.max(0, el.scrollWidth - el.clientWidth),
      }))
      .filter((t) => t.hidden > 1);

    // A phone renders the table as cards; those cards must fit their panel. This
    // is the check that catches a stacked row growing past the screen (the L16
    // clinic row measured 440 px inside a 320 px phone).
    const stacked = [...document.querySelectorAll('.table--stack')].map((el) => ({
      overflowX: Math.max(0, el.scrollWidth - el.clientWidth),
    }));

    return {
      viewport,
      docScrollWidth: doc.scrollWidth,
      mainWidth: Math.round(box.width),
      mainRight: Math.round(box.right),
      mainScrollWidth: main.scrollWidth,
      mainClientWidth: main.clientWidth,
      widest,
      hiddenTabs,
      stackedOverflow: Math.max(0, ...stacked.map((t) => t.overflowX)),
    };
  });
}

function assertFits(measured, label) {
  expect(
    measured.docScrollWidth,
    `${label}: the document is ${measured.docScrollWidth}px wide in a ${measured.viewport}px viewport`
  ).toBeLessThanOrEqual(measured.viewport + TOLERANCE);

  expect(
    measured.mainWidth,
    `${label}: main is ${measured.mainWidth}px wide in a ${measured.viewport}px viewport`
  ).toBeLessThanOrEqual(measured.viewport + TOLERANCE);

  expect(
    measured.mainRight,
    `${label}: main's right edge is at ${measured.mainRight}px in a ${measured.viewport}px viewport`
  ).toBeLessThanOrEqual(measured.viewport + TOLERANCE);

  expect(
    measured.mainScrollWidth,
    `${label}: main scrolls horizontally (${measured.mainScrollWidth}px of content in ${measured.mainClientWidth}px)`
  ).toBeLessThanOrEqual(measured.mainClientWidth + TOLERANCE);

  expect(
    measured.widest,
    `${label}: content sits past the viewport edge (${JSON.stringify(measured.widest)})`
  ).toBeNull();

  expect(
    measured.hiddenTabs,
    `${label}: a tab strip hides tabs behind an invisible scrollbar (${JSON.stringify(measured.hiddenTabs)})`
  ).toEqual([]);

  // A stacked card row must never be wider than the panel that holds it.
  expect(
    measured.stackedOverflow,
    `${label}: a stacked table row overflows its panel by ${measured.stackedOverflow}px`
  ).toBeLessThanOrEqual(TOLERANCE);
}

for (const size of VIEWPORTS) {
  for (const surface of SURFACES) {
    test(`no undefined L16 width at ${size.name} (${surface.file})`, async ({ browser }) => {
      const context = await browser.newContext({
        storageState: session(surface.file),
        viewport: { width: size.width, height: size.height },
      });
      const page = await context.newPage();

      for (const route of surface.routes) {
        await page.goto(route);
        await expect(page.getByRole('navigation', { name: 'Application' })).toBeVisible();
        // The primary escape hatch must stay visible and reachable, not pushed
        // off a narrow header by the content behind it.
        await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
        await page.waitForSelector('h1', { timeout: 15_000 });
        // Let the page transition settle before measuring.
        await page.waitForTimeout(150);
        assertFits(await measureWidths(page), `${route} @ ${size.name}`);
      }

      await context.close();
    });
  }
}

// The stacked-table breakpoint (720 px) leaves the six-column clinic table as a
// real table on a tablet, where it scrolls inside its bounded panel. That is the
// documented L3 contract, not clipping: assert the panel is the thing that
// scrolls and that `main` is still the width of the screen.
test('a wide table scrolls inside its bounded panel, never the page (tablet)', async ({ browser }) => {
  const context = await browser.newContext({
    storageState: session('viewport-admin.json'),
    viewport: { width: 768, height: 1024 },
  });
  const page = await context.newPage();
  await page.goto('/app/clinic');
  await expect(page.getByRole('heading', { level: 1, name: 'Clinic & staff' })).toBeVisible();

  const panels = await page.evaluate(() => {
    const main = document.querySelector('main');
    return {
      main: Math.round(main.getBoundingClientRect().width),
      viewport: window.innerWidth,
      scrolling: [...document.querySelectorAll('.panel-scroll')].map((el) => ({
        scrolls: el.scrollWidth > el.clientWidth,
        overflowX: getComputedStyle(el).overflowX,
      })),
    };
  });

  expect(panels.main).toBeLessThanOrEqual(panels.viewport + TOLERANCE);
  for (const panel of panels.scrolling) {
    // Either it fits, or it is a real scroll region - never clipped silently.
    expect(panel.scrolls ? panel.overflowX : 'auto').not.toBe('hidden');
  }

  await context.close();
});

// An overlay is subject to the same contract: a dialog wider than a phone would
// be clipped by the shell exactly like a page, and it hides the content behind it
// so nothing else is readable while it is open.
for (const size of VIEWPORTS.filter((v) => v.width <= 390)) {
  test(`the confirmation dialog fits the viewport at ${size.name}`, async ({ browser }) => {
    const context = await browser.newContext({
      storageState: session('viewport-admin.json'),
      viewport: { width: size.width, height: size.height },
    });
    const page = await context.newPage();
    await page.goto('/app/profile');
    await page.getByRole('button', { name: 'Sign out everywhere' }).first().click();

    const dialog = page.getByRole('alertdialog', { name: /sign out everywhere/i });
    await expect(dialog).toBeVisible();

    const measured = await dialog.evaluate((el) => {
      const viewport = window.innerWidth;
      const box = el.getBoundingClientRect();
      let widest = null;
      for (const child of el.querySelectorAll('*')) {
        const rect = child.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.right <= viewport + 1) continue;
        if (!widest || rect.right > widest.right) {
          widest = { tag: child.tagName, right: Math.round(rect.right) };
        }
      }
      return {
        viewport,
        left: Math.round(box.left),
        right: Math.round(box.right),
        width: Math.round(box.width),
        widest,
      };
    });

    expect(measured.left, `dialog starts off-screen at ${size.name}`).toBeGreaterThanOrEqual(-TOLERANCE);
    expect(measured.width, `dialog is wider than ${size.name}`).toBeLessThanOrEqual(
      measured.viewport + TOLERANCE
    );
    expect(measured.right, `dialog ends past the viewport at ${size.name}`).toBeLessThanOrEqual(
      measured.viewport + TOLERANCE
    );
    expect(
      measured.widest,
      `dialog content sits past the viewport edge at ${size.name} (${JSON.stringify(measured.widest)})`
    ).toBeNull();

    await page.keyboard.press('Escape');
    await context.close();
  });
}

// Detail screens are reached by clicking, so the width check walks in at a
// comfortable size and then resizes - the same technique as detail-viewports.
for (const size of VIEWPORTS.filter((v) => v.width <= 390)) {
  test(`detail screens keep the L16 width contract at ${size.name}`, async ({ browser }) => {
    const context = await browser.newContext({
      storageState: session('docs-coordinator.json'),
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    // ---- staff patient detail, including the caregiver grant form -----------
    await page.goto('/app/patients');
    await page.getByRole('row', { name: /PT-DOCS\b/ }).getByRole('button', { name: 'Open' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Synthetic Document Patient' })).toBeVisible();
    await page.setViewportSize({ width: size.width, height: size.height });
    assertFits(await measureWidths(page), `patient detail @ ${size.name}`);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('tab', { name: 'Caregivers' }).click();
    await expect(page.getByRole('button', { name: 'Invite caregiver' })).toBeVisible();
    await page.setViewportSize({ width: size.width, height: size.height });
    assertFits(await measureWidths(page), `patient caregivers @ ${size.name}`);

    // ---- staff episode detail, every tab (the widest of them: Closure) ------
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/app/episodes');
    await page.getByRole('row', { name: /EP-DOCSDRAFT/ }).getByRole('button', { name: 'Open' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'EP-DOCSDRAFT' })).toBeVisible();

    const tabs = await page.getByRole('tab').allTextContents();
    for (const name of tabs) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole('tab', { name, exact: true }).click();
      await page.setViewportSize({ width: size.width, height: size.height });
      assertFits(await measureWidths(page), `episode tab "${name}" @ ${size.name}`);
    }

    await context.close();
  });
}
