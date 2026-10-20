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

// ---------------------------------------------------------------------------
// Deep surfaces: the screens that are reached by CLICKING rather than by a
// top-level URL. They matter more than the list screens because they hold the
// clinical content (documents, care plan, closure wizard, check-ins), and a
// structural defect that only appears after a tab switch would otherwise never
// be audited. Each tab is audited in its own right, not just the landing tab.
// ---------------------------------------------------------------------------

async function openRow(page, reference, wordBoundary = false) {
  const pattern = wordBoundary
    ? new RegExp(`${reference}\\b`)
    : new RegExp(reference.replace(/\./g, '\\.'));
  await page.getByRole('row', { name: pattern }).getByRole('button', { name: 'Open' }).click();
}

async function auditTab(page, tabName, label) {
  await page.getByRole('tab', { name: tabName, exact: true }).click();
  // Tab panels render on demand; waiting for the heading settles the layout
  // before the audit rather than sampling a transition.
  await page.waitForTimeout(400);
  await audit(page, `${label} - ${tabName}`);
}

test.describe('axe accessibility audit - deep surfaces', () => {
  test('staff patient detail and every tab', async ({ browser }) => {
    const context = await browser.newContext({
      storageState: session('docs-coordinator.json'),
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    await page.goto('/app/patients');
    await expect(page.getByRole('heading', { level: 1, name: 'Patients' })).toBeVisible();
    await openRow(page, 'PT-DOCS', true);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Synthetic Document Patient' })
    ).toBeVisible();
    await audit(page, 'patient detail');

    for (const tab of ['Consent', 'Caregivers', 'Team']) {
      // eslint-disable-next-line no-await-in-loop
      await auditTab(page, tab, 'patient detail');
    }

    await context.close();
  });

  test('staff episode detail and every tab, including documents', async ({ browser }) => {
    const context = await browser.newContext({
      storageState: session('docs-coordinator.json'),
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    await page.goto('/app/episodes');
    await expect(page.getByRole('heading', { level: 1, name: 'Episodes' })).toBeVisible();
    await openRow(page, 'EP-DOCSDRAFT');
    await expect(page.getByRole('heading', { level: 1, name: 'EP-DOCSDRAFT' })).toBeVisible();
    await audit(page, 'episode detail');

    for (const tab of ['Plan', 'Schedule', 'Corrections', 'Team', 'Documents', 'Closure']) {
      // eslint-disable-next-line no-await-in-loop
      await auditTab(page, tab, 'episode detail');
    }

    await context.close();
  });

  test('patient self-service surfaces', async ({ browser }) => {
    const context = await browser.newContext({
      storageState: session('docs-patient.json'),
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    for (const route of [
      { name: 'my day', url: '/app' },
      { name: 'my episodes', url: '/app/me/episodes' },
      { name: 'my care', url: '/app/me/care' },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await visit(page, route);
      // eslint-disable-next-line no-await-in-loop
      await audit(page, route.name);
    }
    await context.close();
  });

  test('caregiver scoped surfaces', async ({ browser }) => {
    const context = await browser.newContext({
      storageState: session('docs-caregiver.json'),
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    await page.goto('/app/caregiver');
    await expect(
      page.getByRole('heading', { level: 1, name: 'People who shared their care with me' })
    ).toBeVisible();
    await page.waitForTimeout(350);
    await audit(page, 'caregiver home');

    await openRow(page, 'PT-DOCSPAT');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Synthetic Linked Document Patient' })
    ).toBeVisible();
    await page.waitForTimeout(350);
    await audit(page, 'caregiver patient view');

    await page.getByRole('link', { name: 'Check-ins, questions and follow-ups' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Care you help with' })).toBeVisible();
    await page.waitForTimeout(400);
    await audit(page, 'caregiver care panel');

    await context.close();
  });

  test('auth screens and an invitation error state', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    for (const route of [
      { name: 'forgot password', url: '/forgot-password' },
      // A syntactically valid but unknown token drives the ERROR state of the
      // acceptance screen, which is the surface a real visitor can hit.
      { name: 'invalid invitation', url: '/accept-invite/not-a-real-token' },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await visit(page, route);
      // eslint-disable-next-line no-await-in-loop
      await audit(page, route.name);
    }

    await context.close();
  });
});
