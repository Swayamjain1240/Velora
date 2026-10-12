'use strict';

// Part 5 browser journey: the complete synthetic M1 vertical slice.
//
//   patient -> episode -> ready document -> manual draft -> clinical review
//           -> approval -> patient's current approved view
//
// The sessions come from e2e/global-setup.js and the fixture (episode
// EP-PLANJRNY with an assigned coordinator, an assigned VERIFIED reviewer and a
// ready source document, and NO plan data) comes from server/scripts/seed.js, so
// this file always starts from an empty plan slot.
//
// Nothing here is generated: every clinical string is typed by hand, exactly as
// the manual flow requires. Approval must activate no task and no reminder.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { VIEWPORTS } = require('./helpers');

const RUN = Date.now().toString(36);
const EPISODE = 'EP-PLANJRNY';
const SOURCE_FILE = 'synthetic-discharge-summary.pdf';

const TITLE = `Synthetic recovery plan ${RUN}`;
const MEDICATION_WORDING = `Paracetamol 500 mg orally every 6 hours for 3 days (synthetic ${RUN})`;
const INSTRUCTION_WORDING = `Keep the dressing dry for 48 hours (synthetic ${RUN})`;
const QUOTE = `Paracetamol 500 mg orally every 6 hours for 3 days (synthetic ${RUN})`;

function session(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '.auth', file), 'utf8'));
}

// Item headings are truncated for display, so a locator matches on a stable
// prefix of the clinical sentence rather than the whole string.
function short(wording) {
  return wording.slice(0, 40);
}

// Navigation happens at a comfortable size; measurements are taken afterwards at
// each required size so a small viewport is never responsible for reaching a
// control.
const FULL = { width: 1440, height: 900 };

async function openStaffEpisode(page, reference) {
  await page.goto('/app/episodes');
  await expect(page.getByRole('heading', { level: 1, name: 'Recovery episodes' })).toBeVisible();
  await page
    .getByRole('row', { name: new RegExp(reference) })
    .getByRole('button', { name: 'Open' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: reference })).toBeVisible();
  await page.getByRole('tab', { name: 'Plan' }).click();
  await expect(page.getByRole('heading', { name: 'Care plan' })).toBeVisible();
}

function planTab(page, name) {
  return page.getByRole('tab', { name, exact: true });
}

async function measureOneViewport(page, label) {
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
  expect(metrics.overflow, `${label} overflows the viewport`).toBeLessThanOrEqual(2);
  expect(metrics.clipped, `${label} clips content with overflow:hidden`).toBe(false);
}

// Step 1 holds the core clinical fields; the remaining instructions live on
// step 2, so each group is filled on the step that actually renders it.
async function addItem(page, { kindLabel, wording, core = [], extra = [] }) {
  await page.getByRole('button', { name: 'Add item' }).click();
  await page.getByLabel('Item type').selectOption({ label: kindLabel });
  await page.getByLabel(/Original wording/i).fill(wording);
  for (const [label, value] of core) {
    // eslint-disable-next-line no-await-in-loop
    await page.getByLabel(label, { exact: false }).first().fill(value);
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  for (const [label, value] of extra) {
    // eslint-disable-next-line no-await-in-loop
    await page.getByLabel(label, { exact: false }).first().fill(value);
  }
  await page.getByRole('button', { name: 'Add item' }).click();
  await expect(page.getByText(wording, { exact: false }).first()).toBeVisible();
}

// The source panel targets items by their position in the seeded draft, so the
// journey does not depend on ordering by full clinical sentence.
async function linkSource(page, itemIndex, quote) {
  await page.getByLabel('Item').selectOption({ index: itemIndex });
  await page.getByLabel('Ready document').selectOption({ label: SOURCE_FILE });
  await page.getByLabel('Quoted text').fill(quote);
  await page.getByLabel('Page', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Link source' }).click();
  await expect(page.getByText('Source reference linked.')).toBeVisible();
}

test('the synthetic M1 journey: coordinator drafts, reviewer approves, patient reads', async ({
  browser,
}) => {
  test.setTimeout(180_000);

  // ---------------------------------------------------------------- coordinator
  const coordinator = await browser.newContext({
    storageState: session('plan-coordinator.json'),
    viewport: FULL,
  });
  const page = await coordinator.newPage();

  await openStaffEpisode(page, EPISODE);
  await expect(page.getByText(/No plan version yet/)).toBeVisible();

  // A manual draft version, authored through the wizard.
  await page.getByRole('button', { name: 'New draft version' }).click();
  await expect(page.getByText(/Step 1 · Basis/)).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel(/Title \(optional\)/i).fill(TITLE);
  await page.getByLabel(/Summary \(optional\)/i).fill('Synthetic manual plan for the Part 5 journey.');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Create draft version' }).click();
  await expect(page.getByText('Draft version created.')).toBeVisible();

  await addItem(page, {
    kindLabel: 'Medication',
    wording: MEDICATION_WORDING,
    core: [
      ['Medication name', 'Paracetamol'],
      ['Dose (as written)', '500 mg'],
      ['Route', 'oral'],
      ['Frequency', 'every 6 hours'],
      ['Duration', '3 days'],
    ],
  });
  await addItem(page, {
    kindLabel: 'Instruction',
    wording: INSTRUCTION_WORDING,
    extra: [['Warning instruction', 'Contact the clinic if the wound becomes hot or red.']],
  });

  // Both items are complete, so nothing blocks approval on clinical grounds.
  await expect(page.getByText(/All required clinical fields are stated/).first()).toBeVisible();

  // Every item cites the READY document; an unsourced plan cannot be submitted.
  await planTab(page, 'Sources').click();
  await linkSource(page, 0, QUOTE);
  await linkSource(page, 1, 'Keep the dressing dry for 48 hours.');

  await planTab(page, 'Draft').click();
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByText('Submitted for clinical review.')).toBeVisible();
  await expect(page.getByText(/v1 · In review/)).toBeVisible();

  // ------------------------------------------------------------------- reviewer
  const reviewer = await browser.newContext({
    storageState: session('plan-reviewer.json'),
    viewport: FULL,
  });
  const reviewerPage = await reviewer.newPage();
  await openStaffEpisode(reviewerPage, EPISODE);
  await planTab(reviewerPage, 'Review').click();

  // Each item is clinically accepted against its source before approval.
  for (const wording of [MEDICATION_WORDING, INSTRUCTION_WORDING]) {
    // eslint-disable-next-line no-await-in-loop
    await reviewerPage
      .locator('.plans__item', { hasText: short(wording) })
      .getByRole('button', { name: 'Accept' })
      .click();
    // eslint-disable-next-line no-await-in-loop
    await expect(reviewerPage.getByText(/Item accepted/)).toBeVisible();
  }

  // Approval is explicit about its consequences and cannot be sent unconfirmed.
  await reviewerPage.getByRole('button', { name: 'Review approval' }).click();
  const publish = reviewerPage.getByRole('button', { name: 'Approve and publish' });
  await expect(publish).toBeDisabled();
  await expect(reviewerPage.getByText(/superseded and cannot be edited/)).toBeVisible();
  await expect(reviewerPage.getByText(/No task, reminder or message is created/)).toBeVisible();
  await reviewerPage
    .getByRole('checkbox', { name: /I have reviewed the content/i })
    .check();
  await publish.click();
  await expect(reviewerPage.getByText('Approved. The patient now sees this version.')).toBeVisible();

  // The approved version is immutable for the drafting role. Both screens are
  // reloaded first, so what is asserted (and later measured) is the state the
  // approval actually produced, not a copy held from before it.
  // The episode detail is a state-swapped view inside /app/episodes, so a reload
  // returns to the list and the episode is opened again.
  await reviewerPage.reload();
  await openStaffEpisode(reviewerPage, EPISODE);

  await page.reload();
  await openStaffEpisode(page, EPISODE);
  await expect(page.getByText(/approved and immutable/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add item' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Submit for review' })).toBeDisabled();

  // ---------------------------------------------------------------------- patient
  const patient = await browser.newContext({
    storageState: session('plan-patient.json'),
    viewport: FULL,
  });
  const patientPage = await patient.newPage();
  await patientPage.goto('/app/me/episodes');
  await expect(
    patientPage.getByRole('heading', { level: 1, name: 'My recovery episodes' })
  ).toBeVisible();
  await patientPage
    .getByRole('row', { name: new RegExp(EPISODE) })
    .getByRole('button', { name: 'Open' })
    .click();

  // The patient sees ONLY the current approved version, with its sources.
  await expect(patientPage.getByText(TITLE)).toBeVisible();
  await expect(patientPage.getByText(/Approved v\d+/)).toBeVisible();
  // The wording appears as the item heading AND as a labelled field value; both
  // are plain text.
  await expect(patientPage.getByText(MEDICATION_WORDING, { exact: false }).first()).toBeVisible();
  await patientPage.getByText('Where this comes from').first().click();
  await expect(patientPage.getByText(QUOTE).first()).toBeVisible();

  // Approval activated nothing: no task, reminder or schedule appears anywhere.
  await expect(patientPage.getByRole('link', { name: /task|reminder|schedule/i })).toHaveCount(0);
  await expect(patientPage.getByRole('button', { name: /task|reminder|schedule/i })).toHaveCount(0);
  await expect(patientPage.getByRole('heading', { name: /task|reminder/i })).toHaveCount(0);

  // ------------------------------------------------- one viewport at six sizes
  for (const size of VIEWPORTS) {
    for (const [target, label, tab] of [
      [page, 'coordinator draft', 'Draft'],
      [page, 'coordinator sources', 'Sources'],
      [reviewerPage, 'reviewer review', 'Review'],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await target.setViewportSize(FULL);
      // eslint-disable-next-line no-await-in-loop
      await planTab(target, tab).click();
      // eslint-disable-next-line no-await-in-loop
      await target.setViewportSize({ width: size.width, height: size.height });
      // eslint-disable-next-line no-await-in-loop
      await measureOneViewport(target, `${label} plan screen @ ${size.name}`);
    }

    // eslint-disable-next-line no-await-in-loop
    await patientPage.setViewportSize({ width: size.width, height: size.height });
    // eslint-disable-next-line no-await-in-loop
    await measureOneViewport(patientPage, `patient approved plan @ ${size.name}`);
  }

  await coordinator.close();
  await reviewer.close();
  await patient.close();
});
