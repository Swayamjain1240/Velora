'use strict';

// VEL-017 / control #25 for DETAIL screens.
//
// viewports.spec.js measures the list routes; this spec walks into the detail
// views that are reached by clicking, and closes the two remaining gaps in the
// one-viewport evidence: the staff patient detail and the caregiver's scoped
// view of a granted patient. The staff episode detail (including its documents
// tab) is measured at every size by documents.spec.js.
//
// Navigation happens at a comfortable size and the viewport is then resized, so
// the measurement is taken on the detail screen at each required size without
// making the Part 3 list responsible for reaching a control at 320x400.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { VIEWPORTS } = require('./helpers');

const STAFF_PATIENT = 'PT-DOCS';
// The staff patient detail headings show the patient name, while the episode
// detail shows the episode reference.
const STAFF_PATIENT_NAME = 'Synthetic Document Patient';
const STAFF_EPISODE = 'EP-DOCSDRAFT';
const CAREGIVER_PATIENT = 'PT-DOCSPAT';
const CAREGIVER_PATIENT_NAME = 'Synthetic Linked Document Patient';
const TOLERANCE = 2;

function session(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '.auth', file), 'utf8'));
}

// A page that overflows, or that hides content behind overflow:hidden, fails.
async function assertOneViewport(page, label) {
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    return {
      overflow: doc.scrollHeight - window.innerHeight,
      clipped:
        body.scrollHeight > doc.clientHeight + 1 &&
        getComputedStyle(body).overflowY === 'hidden',
    };
  });
  expect(metrics.overflow, `${label} overflows the viewport`).toBeLessThanOrEqual(TOLERANCE);
  expect(metrics.clipped, `${label} clips content with overflow:hidden`).toBe(false);
}

// `wordBoundary` keeps PT-DOCS from matching the PT-DOCSPAT row.
function rowFor(page, reference, wordBoundary = false) {
  const pattern = wordBoundary
    ? new RegExp(`${reference}\\b`)
    : new RegExp(reference.replace(/\./g, '\\.'));
  return page.getByRole('row', { name: pattern });
}

for (const size of VIEWPORTS) {
  test(`detail screens fit one viewport at ${size.name}`, async ({ browser }) => {
    // ---- staff patient detail -------------------------------------------------
    const staff = await browser.newContext({
      storageState: session('docs-coordinator.json'),
      viewport: { width: 1440, height: 900 },
    });
    const page = await staff.newPage();

    await page.goto('/app/patients');
    await expect(page.getByRole('heading', { level: 1, name: 'Patients' })).toBeVisible();
    await rowFor(page, STAFF_PATIENT, true).getByRole('button', { name: 'Open' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: STAFF_PATIENT_NAME })
    ).toBeVisible();

    await page.setViewportSize({ width: size.width, height: size.height });
    await assertOneViewport(page, `patient detail @ ${size.name}`);
    await expect(page.getByRole('button', { name: 'Back' })).toBeVisible();

    // ---- staff patient detail: caregivers tab ----------------------------------
    // Part 7 added a caregiver grant form here (the explicit `log_tasks` write
    // scope), so the tab is measured in its own right instead of riding on the
    // overview measurement.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('tab', { name: 'Caregivers' }).click();
    await expect(page.getByRole('button', { name: 'Invite caregiver' })).toBeVisible();
    await page.setViewportSize({ width: size.width, height: size.height });
    await assertOneViewport(page, `patient caregivers tab @ ${size.name}`);

    // ---- staff episode detail (overview tab) ---------------------------------
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/app/episodes');
    await rowFor(page, STAFF_EPISODE).getByRole('button', { name: 'Open' }).click();
    await expect(page.getByRole('heading', { level: 1, name: STAFF_EPISODE })).toBeVisible();

    await page.setViewportSize({ width: size.width, height: size.height });
    await assertOneViewport(page, `episode detail @ ${size.name}`);
    await expect(page.getByRole('tab', { name: 'Documents' })).toBeVisible();

    await staff.close();

    // ---- caregiver's scoped view of a granted patient -------------------------
    const caregiver = await browser.newContext({
      storageState: session('docs-caregiver.json'),
      viewport: { width: 1440, height: 900 },
    });
    const caregiverPage = await caregiver.newPage();

    await caregiverPage.goto('/app/caregiver');
    await expect(
      caregiverPage.getByRole('heading', { level: 1, name: 'People who shared their care with me' })
    ).toBeVisible();

    // The grant is on the linked patient only, so this row must exist: it proves
    // the caregiver session is scoped, not empty.
    const caregiverRow = caregiverPage.getByRole('row', { name: new RegExp(CAREGIVER_PATIENT) });
    await expect(caregiverRow).toHaveCount(1);
    await caregiverRow.getByRole('button', { name: 'Open' }).click();
    await expect(
      caregiverPage.getByRole('heading', { level: 1, name: CAREGIVER_PATIENT_NAME })
    ).toBeVisible();
    await expect(caregiverPage.getByText(/profile only/i)).toBeVisible();

    await caregiverPage.setViewportSize({ width: size.width, height: size.height });
    await assertOneViewport(caregiverPage, `caregiver view @ ${size.name}`);

    // ---- caregiver's scoped care panel (Part 8) ------------------------------
    // The check-ins/questions/follow-ups panel is reached by a click because the
    // grant-scoped patient id is part of the path; it is measured in its own
    // right at each size like every other detail screen.
    await caregiverPage.setViewportSize({ width: 1440, height: 900 });
    await caregiverPage
      .getByRole('link', { name: 'Check-ins, questions and follow-ups' })
      .click();
    await expect(
      caregiverPage.getByRole('heading', { level: 1, name: 'Care you help with' })
    ).toBeVisible();
    await caregiverPage.setViewportSize({ width: size.width, height: size.height });
    await assertOneViewport(caregiverPage, `caregiver care panel @ ${size.name}`);

    await caregiver.close();
  });
}
