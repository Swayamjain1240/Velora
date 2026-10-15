'use strict';

// Part 9 browser journey: the closure wizard and its read-only state, the audit
// search, the retention dry run and the switchable metric panels.
//
// The API integration suite owns the Part 9 transitions (close, reopen, request
// state machine, retention apply). This journey proves the part is reachable and
// safe through the REAL session and the real server: the wizard cannot be
// confirmed until the clinic-policy checks and a reason are supplied, a closed
// episode is offered a reopen - never a second close - the audit trail is
// administrative and paginated, retention reports before it acts, and every
// metric carries its "not a measure of" line.
//
// Nothing here mutates clinical state: the journey reads the seeded closed
// episode, runs a dry run (which changes nothing) and stops before submitting.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const TOLERANCE = 2;

// The seeded episodes (server/scripts/seedDocumentJourney.js). EP-DOCSDRAFT is
// open; EP-DOCCLOSED is already archived.
const OPEN_EPISODE = 'EP-DOCSDRAFT';
const CLOSED_EPISODE = 'EP-DOCCLOSED';

function session(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '.auth', file), 'utf8'));
}

async function contextFor(browser, file) {
  return browser.newContext({
    storageState: session(file),
    viewport: { width: 1440, height: 900 },
  });
}

async function assertOneViewport(page, label) {
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    return {
      overflow: doc.scrollHeight - window.innerHeight,
      clipped:
        body.scrollHeight > doc.clientHeight + 1 && getComputedStyle(body).overflowY === 'hidden',
    };
  });
  expect(metrics.overflow, `${label} overflows the viewport`).toBeLessThanOrEqual(TOLERANCE);
  expect(metrics.clipped, `${label} clips content with overflow:hidden`).toBe(false);
}

async function openEpisode(page, reference) {
  await page.goto('/app/episodes');
  const row = page.getByRole('row', { name: new RegExp(reference) });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { level: 1, name: reference })).toBeVisible();
  await page.getByRole('tab', { name: 'Closure' }).click();
  await expect(page.getByRole('tab', { name: 'History' })).toBeVisible();
}

test('the closure wizard refuses to be confirmed without its checks, and a closed episode offers a reopen', async ({ browser }) => {
  const context = await contextFor(browser, 'docs-coordinator.json');
  const page = await context.newPage();

  // ---- an OPEN episode: preflight -> checks -> confirm ------------------------
  await openEpisode(page, OPEN_EPISODE);

  // The wording is operational. Closure is never presented as recovery.
  await expect(page.getByText(/does not mean the patient has recovered/i)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Closure preflight' })).toBeVisible();
  await expect(page.getByText('Outstanding work')).toBeVisible();
  await expect(page.getByText('Blocks closure')).toBeVisible();

  await page.getByRole('button', { name: 'Continue to policy checks' }).click();
  await expect(page.getByRole('group', { name: 'Clinic-policy checks' })).toBeVisible();

  // The gate: no confirmed check, no reason -> no review step.
  await expect(page.getByRole('button', { name: 'Review' })).toBeDisabled();

  for (const box of await page.getByRole('checkbox').all()) {
    await box.check();
  }
  await page.getByLabel('Reason').fill('Coordination work for this episode is complete.');
  await expect(page.getByRole('button', { name: 'Review' })).toBeEnabled();

  await page.getByRole('button', { name: 'Review' }).click();
  await expect(page.getByText(/archives this episode as read-only/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close episode' })).toBeVisible();

  // The wizard is abandoned here on purpose: this journey must not close a
  // seeded episode that other journeys still use, so the history switch is what
  // is exercised next rather than a submit.

  // ---- the history switch -----------------------------------------------------
  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByRole('table', { name: 'Closure history' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Action' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Closure history pagination' })).toBeVisible();

  await assertOneViewport(page, 'closure history');
  await context.close();

  // ---- an ALREADY CLOSED episode: read-only, reopen is the only path out ------
  const closedContext = await contextFor(browser, 'docs-coordinator.json');
  const closedPage = await closedContext.newPage();
  await openEpisode(closedPage, CLOSED_EPISODE);

  // The wizard cannot move forward on a closed episode.
  await expect(closedPage.getByRole('button', { name: 'Continue to policy checks' })).toBeDisabled();
  await expect(closedPage.getByRole('heading', { name: 'Reopen' })).toBeVisible();
  await expect(closedPage.getByText(/never revives work that was stopped/i)).toBeVisible();

  // A reopen needs an explicit, justified reason before it can be attempted.
  const reopen = closedPage.getByRole('button', { name: 'Reopen episode' });
  await expect(reopen).toBeDisabled();
  await closedPage.getByLabel('Reason').fill('Coordination is resuming for this patient.');
  await expect(reopen).toBeEnabled();

  // A closed episode keeps its history readable.
  await closedPage.getByRole('tab', { name: 'History' }).click();
  await expect(closedPage.getByRole('table', { name: 'Closure history' })).toBeVisible();

  await assertOneViewport(closedPage, 'closed episode closure tab');
  await closedContext.close();
});

test('the audit trail is administrative, filterable and paginated', async ({ browser }) => {
  const context = await contextFor(browser, 'viewport-admin.json');
  const page = await context.newPage();

  await page.goto('/app/audit');
  await expect(page.getByRole('heading', { level: 1, name: 'Audit trail' })).toBeVisible();

  // Someone has acted in this synthetic clinic, so the trail is not empty and
  // every row is rendered from the server's scoped, paginated read.
  const rows = page.locator('table tbody tr');
  await expect(rows.first()).toBeVisible();
  const before = await rows.count();
  expect(before).toBeGreaterThan(0);

  // A category filter narrows the same read; the catalog comes from the server.
  await page.getByLabel('Category').selectOption('closure');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('navigation', { name: 'Audit pagination' })).toBeVisible();
  await expect(page.getByText('Page 1')).toBeVisible();

  // Filtering to a category nobody has written is allowed and simply matches
  // nothing - the trail never widens the scope to fill the page.
  await page.getByLabel('Category').selectOption('membership');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('navigation', { name: 'Audit pagination' })).toBeVisible();

  await assertOneViewport(page, 'audit trail');
  await context.close();
});

test('retention reports before it acts and gates the apply', async ({ browser }) => {
  const context = await contextFor(browser, 'viewport-admin.json');
  const page = await context.newPage();

  await page.goto('/app/retention');
  await expect(page.getByRole('heading', { level: 1, name: 'Retention' })).toBeVisible();
  await expect(page.getByText(/never destroys clinical records automatically/i)).toBeVisible();

  // Clinical categories are report-only, and the default windows are visible.
  await expect(page.getByRole('table', { name: 'Retention categories' })).toBeVisible();
  await expect(page.getByText('report-only').first()).toBeVisible();
  await expect(page.getByText('documents').first()).toBeVisible();

  // Applying is gated on an operator name AND a stated reason.
  const apply = page.getByRole('button', { name: 'Apply retention' });
  await expect(apply).toBeDisabled();
  await page.getByLabel('Operator').fill('synthetic.operator@synthetic.invalid');
  await expect(apply).toBeDisabled();
  await page.getByLabel('Reason').fill('Synthetic clinic policy: expire sessions past their window.');
  await expect(apply).toBeEnabled();

  // A dry run changes nothing and still reports; the journey stops there.
  await page.getByRole('button', { name: 'Run dry run' }).click();
  await expect(page.getByRole('status')).toContainText(/Nothing was changed/i);

  await assertOneViewport(page, 'retention console');
  await context.close();
});

test('the metric panels switch, and each one says what it does not measure', async ({ browser }) => {
  const context = await contextFor(browser, 'viewport-reviewer.json');
  const page = await context.newPage();

  await page.goto('/app/metrics');
  await expect(page.getByRole('heading', { level: 1, name: 'Workflow metrics' })).toBeVisible();

  // The service states its own limit; the screen repeats it.
  await expect(page.getByText(/not clinical outcomes/i)).toBeVisible();

  const tabs = page.getByRole('tablist', { name: 'Metric panels' });
  await expect(tabs).toBeVisible();

  // One switchable panel at a time: the tab label and the metric's own label
  // differ, so both are asserted.
  const PANELS = [
    { tab: 'Approvals', heading: 'Plan approval time' },
    { tab: 'Clarifications', heading: 'Clarification response time' },
    { tab: 'Queue age', heading: 'Queue age' },
    { tab: 'Workload', heading: 'Coordination workload' },
  ];
  for (const panel of PANELS) {
    await page.getByRole('tab', { name: panel.tab }).click();
    await expect(page.getByRole('heading', { level: 2, name: panel.heading })).toBeVisible();
    await expect(page.getByText(/Not a measure of:/).first()).toBeVisible();
    await assertOneViewport(page, `metrics ${panel.tab}`);
  }

  // Queue age is the operational queue view, not a clinical one.
  await page.getByRole('tab', { name: 'Queue age' }).click();
  await expect(page.getByRole('table', { name: 'Queue age by queue' })).toBeVisible();

  await context.close();
});
