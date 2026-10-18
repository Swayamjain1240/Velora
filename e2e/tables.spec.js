'use strict';

// L3: the same table has two presentations. Above 720 px it keeps its columns;
// below that each row is a card and every cell is prefixed with its column name.
// This measures the rendered layout - display, generated label, scroll width -
// rather than trusting the stylesheet.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

function session(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '.auth', file), 'utf8'));
}

async function inspectTable(page, selector) {
  return page.evaluate((sel) => {
    const table = document.querySelector(sel);
    if (!table) return null;
    const row = table.querySelector('tbody tr');
    const cells = [...(row ? row.querySelectorAll('td') : [])];
    return {
      tableScrollWidth: table.scrollWidth,
      tableClientWidth: table.clientWidth,
      rowDisplay: row ? getComputedStyle(row).display : null,
      headDisplay: getComputedStyle(table.querySelector('thead')).display,
      labels: cells.map((cell) => cell.getAttribute('data-label')),
      prefix: cells[0]
        ? getComputedStyle(cells[0], '::before').content.replace(/^"|"$/g, '')
        : null,
      roles: {
        table: table.getAttribute('role'),
        row: row ? row.getAttribute('role') : null,
        cell: cells[0] ? cells[0].getAttribute('role') : null,
      },
    };
  }, selector);
}

test('on a phone the metrics tables become labelled cards', async ({ browser }) => {
  const context = await browser.newContext({
    storageState: session('viewport-reviewer.json'),
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto('/app/metrics');
  await expect(page.getByRole('navigation', { name: 'Application' })).toBeVisible();
  // The default panel is a summary; the queue-age panel is the one with tables.
  await page.getByRole('tab', { name: /queue age/i }).click();
  await page.waitForSelector('.table--stack');

  const info = await inspectTable(page, '.table--stack');
  expect(info).not.toBeNull();
  expect(info.rowDisplay).toBe('block');
  // The header row stays in the accessibility tree (clipped, not removed).
  expect(info.headDisplay).not.toBe('none');
  expect(info.labels.length).toBeGreaterThan(0);
  expect(info.labels.every(Boolean)).toBe(true);
  expect(info.prefix.toLowerCase()).toBe(info.labels[0].toLowerCase());
  // Explicit roles survive the display change.
  expect(info.roles.table).toBe('table');
  expect(info.roles.row).toBe('row');
  expect(info.roles.cell).toBe('cell');
  // A card never needs a sideways scroll.
  expect(info.tableScrollWidth).toBeLessThanOrEqual(info.tableClientWidth + 2);

  await context.close();
});

test('on a desktop the same table keeps its rows and columns', async ({ browser }) => {
  const context = await browser.newContext({
    storageState: session('viewport-reviewer.json'),
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await page.goto('/app/metrics');
  await expect(page.getByRole('navigation', { name: 'Application' })).toBeVisible();
  await page.getByRole('tab', { name: /queue age/i }).click();
  await page.waitForSelector('.table--stack');

  const info = await inspectTable(page, '.table--stack');
  expect(info.rowDisplay).toBe('table-row');
  expect(info.headDisplay).not.toBe('none');

  await context.close();
});

test('a phone never scrolls a clinical table sideways', async ({ browser }) => {
  const context = await browser.newContext({
    storageState: session('viewport-admin.json'),
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  for (const route of ['/app/clinic', '/app/metrics', '/app/audit', '/app/retention']) {
    // eslint-disable-next-line no-await-in-loop
    await page.goto(route);
    // eslint-disable-next-line no-await-in-loop
    await expect(page.getByRole('navigation', { name: 'Application' })).toBeVisible();
    // eslint-disable-next-line no-await-in-loop
    const overflow = await page.evaluate(() =>
      [...document.querySelectorAll('.table--stack')].map(
        (table) => table.scrollWidth - table.clientWidth
      )
    );
    expect(overflow.every((delta) => delta <= 2), `${route}: ${overflow.join(',')}`).toBe(true);
  }
  await context.close();
});
