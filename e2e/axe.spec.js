'use strict';

// L4: automated accessibility audit (axe-core) across the public and signed-in
// surfaces. This complements the keyboard journey in accessibility.spec.js: it
// catches structural and contrast defects a Tab walk cannot see.
//
// The audit runs the WCAG 2.1 A/AA rule set. It deliberately does not filter by
// impact: a violation of any impact fails, because "serious" versus "moderate"
// is a triage label, not a pass. Where a rule is genuinely inapplicable (for
// example the decorative canvas being aria-hidden), the element is excluded by
// the product, not by a disableRules call.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

function session(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '.auth', file), 'utf8'));
}

const PUBLIC_ROUTES = [
  { name: 'landing', url: '/' },
  { name: 'sign in', url: '/login' },
];

const REVIEWER_ROUTES = [
  { name: 'dashboard', url: '/app' },
  { name: 'patients', url: '/app/patients' },
  { name: 'episodes', url: '/app/episodes' },
  { name: 'today', url: '/app/today' },
  { name: 'queues', url: '/app/queues' },
  { name: 'metrics', url: '/app/metrics' },
  { name: 'audit', url: '/app/audit' },
  { name: 'profile', url: '/app/profile' },
];

const ADMIN_ROUTES = [
  { name: 'clinic settings', url: '/app/clinic' },
  { name: 'privacy requests', url: '/app/privacy' },
  { name: 'retention', url: '/app/retention' },
];

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function audit(page, label) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const summary = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.map((node) => ({
      target: node.target.join(' '),
      summary: node.failureSummary,
    })),
  }));
  expect(
    results.violations,
    `${label}: ${results.violations.length} accessibility violation(s)\n${JSON.stringify(summary, null, 2)}`
  ).toEqual([]);
}

async function visit(page, route) {
  await page.goto(route.url);
  // The shell renders a status region while the session check resolves; waiting
  // for the h1 avoids auditing a loading screen.
  await page.waitForSelector('h1', { timeout: 15_000 });
  await page.waitForTimeout(350);
}

test.describe('axe accessibility audit', () => {
  test('public surfaces', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    for (const route of PUBLIC_ROUTES) {
      // eslint-disable-next-line no-await-in-loop
      await visit(page, route);
      // eslint-disable-next-line no-await-in-loop
      await audit(page, route.name);
    }
    await context.close();
  });

  test('reviewer surfaces', async ({ browser }) => {
    const context = await browser.newContext({
      storageState: session('viewport-reviewer.json'),
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    for (const route of REVIEWER_ROUTES) {
      // eslint-disable-next-line no-await-in-loop
      await visit(page, route);
      // eslint-disable-next-line no-await-in-loop
      await audit(page, route.name);
    }
    await context.close();
  });

  test('administrator surfaces', async ({ browser }) => {
    const context = await browser.newContext({
      storageState: session('viewport-admin.json'),
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    for (const route of ADMIN_ROUTES) {
      // eslint-disable-next-line no-await-in-loop
      await visit(page, route);
      // eslint-disable-next-line no-await-in-loop
      await audit(page, route.name);
    }
    await context.close();
  });

  test('phone layout of the care-plan and episode screens', async ({ browser }) => {
    const context = await browser.newContext({
      storageState: session('plan-coordinator.json'),
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    for (const route of [
      { name: 'phone episodes', url: '/app/episodes' },
      { name: 'phone today', url: '/app/today' },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await visit(page, route);
      // eslint-disable-next-line no-await-in-loop
      await audit(page, route.name);
    }
    await context.close();
  });
});
