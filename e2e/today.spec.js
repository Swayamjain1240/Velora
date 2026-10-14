'use strict';

// Part 7 browser journeys: the day view a patient actually uses, the same view
// through a scoped caregiver grant, and the staff workspace that prepares and
// activates schedules from an approved plan.
//
// The seeded journey (server/scripts/seedScheduleJourney.js) supplies an
// approved plan with an activated three-times-daily medicine, a PRN medicine and
// a twice-daily task, starting two local days ago - so a past day always has
// slots that can be recorded against.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { VIEWPORTS } = require('./helpers');

const TOLERANCE = 2;

function session(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '.auth', file), 'utf8'));
}

async function contextFor(browser, file, size = { width: 1440, height: 900 }) {
  return browser.newContext({ storageState: session(file), viewport: size });
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

async function openToday(page) {
  await page.getByRole('link', { name: 'Today' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
}

test('a patient records a past entry and sees self-report wording, never a missed dose', async ({ browser }) => {
  const context = await contextFor(browser, 'schedule-patient.json');
  const page = await context.newPage();

  await page.goto('/app');
  await openToday(page);

  // The seeded approved plan is on screen with its verbatim instruction. The
  // same instruction is repeated once per daily slot, so the first row is enough.
  await expect(page.getByText(/Amoxicillin 500 mg orally three times daily for 5 days/).first()).toBeVisible();
  // Its schedule time is shown as a local time with the offset.
  await expect(page.getByText(/09:00 \(\+0/).first()).toBeVisible();

  // Nothing recorded yet on the current day: the wording is explicit and the
  // page never calls it a missed dose.
  await expect(page.getByText('No entry recorded').first()).toBeVisible();
  await expect(page.getByText(/No entry recorded\. This is not a missed dose\./).first()).toBeVisible();
  await expect(page.getByText(/missed a dose/i)).toHaveCount(0);
  await expect(
    page.getByText(/never means you should take an extra or replacement dose/i)
  ).toBeVisible();

  // Record against a PAST day, where every slot is already due.
  await page.getByRole('button', { name: /Previous/ }).first().click();
  await expect(page.getByText(/Amoxicillin 500 mg orally three times daily for 5 days/).first()).toBeVisible();

  const row = page.locator('.today__row', { hasText: 'Amoxicillin' }).first();
  await row.getByRole('button', { name: 'Taken', exact: true }).click();
  await expect(page.getByText(/Recorded as “Taken”/)).toBeVisible();
  // The row now carries the recorded state as a pill in its head. Target that
  // pill specifically: the same row still offers a "Taken" action button for a
  // later correction, so an unscoped getByText would match twice.
  await expect(
    page.locator('.today__row', { hasText: 'Amoxicillin' }).first().locator('.pill--taken')
  ).toBeVisible();
  // A patient entry is labelled a self-report, not clinician verification.
  await expect(page.getByText(/Recorded by the patient \(self-report\)/).first()).toBeVisible();

  // The Tasks tab is a separate bounded panel, and the PRN medicine is offered
  // as needed rather than as a due dose.
  await page.getByRole('tab', { name: /Tasks/ }).click();
  await expect(page.getByText(/Change the dressing in the morning and at night/).first()).toBeVisible();
  await page.getByRole('tab', { name: /Medication/ }).click();
  await expect(page.getByText('As needed').first()).toBeVisible();
  await expect(page.getByText('No due time').first()).toBeVisible();

  await assertOneViewport(page, 'patient today');
  await context.close();
});

test('a caregiver with log_tasks records an entry, and attribution shows the self-report', async ({ browser }) => {
  const context = await contextFor(browser, 'schedule-caregiver.json');
  const page = await context.newPage();

  await page.goto('/app');
  await openToday(page);

  // The shared record picker is present because this caregiver holds a grant.
  await expect(page.getByLabel(/Shared record/)).toBeVisible();
  await expect(page.getByText(/Amoxicillin 500 mg orally three times daily for 5 days/).first()).toBeVisible();

  await page.getByRole('button', { name: /Previous/ }).first().click();
  const row = page.locator('.today__row', { hasText: 'Amoxicillin' }).first();
  await row.getByRole('button', { name: 'Skipped', exact: true }).click();
  await expect(page.getByText(/Recorded as “Skipped”/)).toBeVisible();
  await expect(page.getByText(/Recorded by a caregiver \(self-report\)/).first()).toBeVisible();
  await expect(page.getByText(/not clinician verified/).first()).toBeVisible();

  await assertOneViewport(page, 'caregiver today');
  await context.close();
});

test('the staff schedule workspace shows prepared schedules, UTC occurrences and recorded entries', async ({ browser }) => {
  const context = await contextFor(browser, 'schedule-coordinator.json');
  const page = await context.newPage();

  await page.goto('/app/episodes');
  const row = page.getByRole('row', { name: /EP-SCHEDJRNY/ });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'EP-SCHEDJRNY' })).toBeVisible();

  await page.getByRole('tab', { name: 'Schedule' }).click();
  await expect(page.getByRole('heading', { name: 'Schedules and tasks' })).toBeVisible();

  // The medicine is active with its daily times; the PRN one has no times at all.
  await expect(page.getByText(/Amoxicillin/).first()).toBeVisible();
  await expect(page.getByText('09:00, 14:00, 21:00')).toBeVisible();
  await expect(page.getByText('As needed').first()).toBeVisible();
  await expect(page.getByText('Active').first()).toBeVisible();

  // The occurrence panel opens on the first schedule, which is the conditional
  // one (it generates none). Open the fixed-dose schedule to read its slots.
  await page.getByRole('row', { name: /Amoxicillin/ }).getByRole('button', { name: 'View' }).click();
  await expect(page.getByRole('heading', { name: 'Occurrences · Amoxicillin' })).toBeVisible();

  // Occurrences are shown as local time AND as the stored UTC instant.
  await expect(page.getByText(/T\d{2}:\d{2}:00\.000Z/).first()).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'UTC instant' })).toBeVisible();

  // The entries the patient and caregiver recorded are visible to the team, with
  // the self-report label intact.
  await expect(page.getByRole('heading', { name: 'Recorded entries' })).toBeVisible();
  await expect(page.getByText('Self-report').first()).toBeVisible();
  await expect(
    page.getByText(/A patient or caregiver entry is a self-report and is never clinical verification/i)
  ).toBeVisible();

  // Preparation is an explicit control, and it is only offered for an approved plan.
  await expect(page.getByRole('button', { name: /Prepare from approved plan/i })).toBeEnabled();
  await assertOneViewport(page, 'staff schedule workspace');
  await context.close();
});

for (const size of VIEWPORTS) {
  test(`the day view fits one viewport at ${size.name}`, async ({ browser }) => {
    const patient = await contextFor(browser, 'schedule-patient.json', size);
    const page = await patient.newPage();
    await page.goto('/app/today');
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
    await expect(page.getByText(/Amoxicillin 500 mg/).first()).toBeVisible();
    await assertOneViewport(page, `today @ ${size.name}`);

    // One category at a time: switching tabs keeps the page inside the viewport.
    await page.getByRole('tab', { name: /Tasks/ }).click();
    await expect(page.getByText(/Change the dressing/).first()).toBeVisible();
    await assertOneViewport(page, `today tasks @ ${size.name}`);
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await patient.close();

    // The staff workspace tab is measured at the same six sizes. As in
    // detail-viewports.spec.js the screen is reached at a comfortable size and
    // then resized, so the list is not the thing under measurement.
    const staff = await contextFor(browser, 'schedule-coordinator.json');
    const staffPage = await staff.newPage();
    await staffPage.goto('/app/episodes');
    await staffPage.getByRole('row', { name: /EP-SCHEDJRNY/ }).getByRole('button', { name: 'Open' }).click();
    await staffPage.getByRole('tab', { name: 'Schedule' }).click();
    await expect(staffPage.getByRole('heading', { name: 'Schedules and tasks' })).toBeVisible();
    await staffPage.setViewportSize({ width: size.width, height: size.height });
    await assertOneViewport(staffPage, `schedule workspace @ ${size.name}`);
    await expect(staffPage.getByRole('tab', { name: 'Schedule' })).toBeVisible();
    await staff.close();
  });
}
