'use strict';

// Part 6 browser journey: AI-assisted extraction, source citations, missing and
// conflict detection, and a reviewed Hindi rendering - all of it on synthetic
// data, against the LOCAL deterministic provider (EXTRACTION_PROVIDER=fake: no
// network, no key), with the manual Part 5 workflow running unchanged beside it.
//
// The fixture (episode EP-AIJRNY with an assigned coordinator, an assigned
// VERIFIED reviewer, a READY synthetic discharge note with a real text layer and
// NO plan data) comes from server/scripts/seed.js, so this journey always starts
// from an empty extraction slot.
//
// What is asserted here is deliberately narrow: the SOFTWARE behaves as
// specified. Software-test success is not clinical accuracy - that is measured
// separately by the evaluation harness (server/scripts/evaluate-extraction.js).
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { VIEWPORTS } = require('./helpers');

const RUN = Date.now().toString(36);
const EPISODE = 'EP-AIJRNY';
const SOURCE_FILE = 'synthetic-discharge-note.pdf';
// The numeric guard requires the ITEM's own numbers (the coordinator accepted
// the 250 mg dose), so the rendering states 250, 6 and 3 - language-neutral.
const HINDI = `\u092a\u0948\u0930\u093e\u0938\u093f\u091f\u093e\u092e\u0949\u0932 250 mg \u092e\u0941\u0902\u0939 \u0938\u0947 \u0939\u0930 6 \u0918\u0902\u091f\u0947 \u092e\u0947\u0902, 3 \u0926\u093f\u0928 \u0924\u0915 (${RUN})`;

const FULL = { width: 1440, height: 900 };

function session(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '.auth', file), 'utf8'));
}

async function openEpisode(page, reference) {
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

function suggestionPanel(page, name) {
  return page.getByRole('tablist', { name: 'Suggestion panels' }).getByRole('tab', { name });
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

test('AI-assisted extraction drafts, cites and never decides; the manual workflow is untouched', async ({
  browser,
}) => {
  test.setTimeout(240_000);

  // ---------------------------------------------------------------- coordinator
  const coordinator = await browser.newContext({
    storageState: session('plan-coordinator.json'),
    viewport: FULL,
  });
  const page = await coordinator.newPage();
  await openEpisode(page, EPISODE);
  await expect(page.getByText(/No plan version yet/)).toBeVisible();

  // A draft version to target: a job may only ever write into a draft.
  await page.getByRole('button', { name: 'New draft version' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel(/Title \(optional\)/i).fill(`AI-assisted recovery plan ${RUN}`);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Create draft version' }).click();
  await expect(page.getByText('Draft version created.')).toBeVisible();

  // ---------------------------------------------------------------- extraction
  await planTab(page, 'Extraction').click();
  await expect(
    page.getByText(/cannot approve, publish, prescribe, change clinical state/i)
  ).toBeVisible();
  // No approval, publication, task or reminder action exists on this screen.
  await expect(page.getByRole('button', { name: /approve|publish|prescrib/i })).toHaveCount(0);

  await page.getByLabel('Ready document').selectOption({ label: SOURCE_FILE });
  await page.getByRole('button', { name: 'Start extraction job' }).click();
  await expect(page.getByText(/Extraction job created\./)).toBeVisible();

  await page.getByRole('button', { name: 'Run extraction job' }).click();
  // The document states no frequency for Amoxicillin and two different
  // Paracetamol doses, so the job cannot be "completed": it needs a human.
  await expect(page.getByText('Needs review').first()).toBeVisible();
  await expect(page.getByText(/needing a human/)).toBeVisible();

  // The suggestion list is paginated and the panels are switchable.
  await expect(page.getByRole('navigation', { name: 'Suggestion pagination' })).toBeVisible();

  // The suggestion rows are addressed by their own wording, never by position:
  // the deterministic provider emits them in document order (Paracetamol 500 mg
  // first, home care second), and the review experience must not depend on that.
  const suggestionsPane = page
    .locator('.plans__pane')
    .filter({ has: page.getByRole('heading', { name: 'Suggestions' }) });

  // Select one suggestion by its own wording and CONFIRM the selection took:
  // the pane loads asynchronously, so a click issued too early would otherwise
  // look successful while the panel still shows the first suggestion.
  async function selectSuggestion(text) {
    const item = suggestionsPane.locator('.plans__item', { hasText: text });
    await expect(item).toHaveCount(1);
    const button = item.getByRole('button');
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }

  // ---- source panel: the citation is the document's own wording, verified
  await suggestionPanel(page, 'Source').click();
  // Scoped to the citation block: an unscoped text match would also hit the
  // (hidden) document <option> in the job form above.
  const citation = page.locator('.plans__source').first();
  await expect(citation).toContainText(SOURCE_FILE);
  await expect(citation).toContainText('Verified against the source');
  await expect(citation).toContainText('Paracetamol 500 mg');

  // ---- missing and conflict detection. The Paracetamol 500 mg suggestion is the
  // one whose dose conflicts with the 1000 mg line AND whose home care, activity,
  // follow-up and warning are simply not stated.
  await selectSuggestion('Paracetamol 500 mg');
  await suggestionPanel(page, 'AI suggestion').click();
  await expect(page.getByText('Conflicting instructions').first()).toBeVisible();
  await expect(page.getByText(/not stated in the source/i).first()).toBeVisible();

  // ---- the value the coordinator accepts, then the separate draft edit
  await suggestionPanel(page, 'Accepted value').click();
  const dose = page.getByLabel(/^Dose/).first();
  await dose.fill('250 mg');
  await suggestionPanel(page, 'Decision').click();
  await expect(page.getByText(/stays “awaiting clinical review”/i)).toBeVisible();
  await page.getByRole('button', { name: 'Apply to draft' }).click();
  await expect(page.getByText(/Applied to the draft as a new item/)).toBeVisible();

  // The applied suggestion became an ORDINARY draft item: still unapproved.
  await planTab(page, 'Draft').click();
  await expect(page.getByText(/250 mg/).first()).toBeVisible();
  await expect(page.getByText(/v1 · Draft/).first()).toBeVisible();
  await expect(page.getByText(/Awaiting clinical review/).first()).toBeVisible();

  // ---- dismissing changes nothing in the draft. The APPLIED suggestion can no
  // longer be decided, so the dismissal targets a suggestion still awaiting one.
  await planTab(page, 'Extraction').click();
  await selectSuggestion('Keep the dressing dry');
  await suggestionPanel(page, 'Decision').click();
  await page.getByLabel('Dismiss this suggestion').fill('Already covered by the paper chart');
  await page.getByRole('button', { name: 'Dismiss suggestion' }).click();
  await expect(page.getByText(/Suggestion dismissed\./)).toBeVisible();
  await expect(page.getByText(/Applied to the draft|Dismissed/).first()).toBeVisible();

  // ---- the manual workflow still works beside it
  await planTab(page, 'Draft').click();
  await expect(page.getByRole('button', { name: 'Add item' })).toBeEnabled();

  // ------------------------------------------------------- Hindi rendering
  await planTab(page, 'Language').click();
  await page.getByLabel('Instruction').selectOption({ index: 1 });
  await page.getByLabel('Language').selectOption('hi');
  await page.getByLabel('Kind').selectOption('translation');
  await page.getByLabel('Wording').fill(HINDI);
  await page.getByRole('button', { name: 'Draft rendering' }).click();
  await expect(page.getByText(/Rendering drafted\./)).toBeVisible();
  await expect(page.getByText(/It never becomes patient-visible/i)).toBeVisible();
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByText('Submitted for clinical review.')).toBeVisible();

  // ------------------------------------------------------------------- reviewer
  const reviewer = await browser.newContext({
    storageState: session('plan-reviewer.json'),
    viewport: FULL,
  });
  const reviewerPage = await reviewer.newPage();
  await openEpisode(reviewerPage, EPISODE);
  await planTab(reviewerPage, 'Language').click();
  await expect(reviewerPage.getByText(/Waiting for clinical review/).first()).toBeVisible();
  // The rendering is shown beside the instruction it renders.
  await expect(reviewerPage.getByText(/Instruction it renders/).first()).toBeVisible();

  const approve = reviewerPage.getByRole('button', { name: 'Approve rendering' });
  await expect(approve).toBeDisabled();
  await reviewerPage
    .getByLabel(/State that the meaning is preserved/i)
    .fill('Same medication, dose, frequency and duration. Meaning preserved.');
  await approve.click();
  await expect(reviewerPage.getByText(/Rendering approved for presentation\./)).toBeVisible();

  // A reviewer sees the extraction job but is offered no approval shortcut for
  // AI output: the only decisions are apply and dismiss, and both are drafting
  // actions the reviewer does not hold.
  await planTab(reviewerPage, 'Extraction').click();
  await expect(
    reviewerPage.getByText(/cannot approve, publish, prescribe, change clinical state/i)
  ).toBeVisible();

  // ---------------------------------------------------------------------- patient
  const patient = await browser.newContext({
    storageState: session('ai-patient.json'),
    viewport: FULL,
  });
  const patientPage = await patient.newPage();
  await patientPage.goto('/app/me/episodes');
  await patientPage
    .getByRole('row', { name: new RegExp(EPISODE) })
    .getByRole('button', { name: 'Open' })
    .click();
  // Nothing is approved, so the patient has no plan, no rendering and no AI text.
  // Scoped to the patient's CONTENT: the shell header legitimately shows the
  // patient's own seeded name ("Synthetic Extraction Journey Patient").
  const patientMain = patientPage.locator('main');
  await expect(patientMain.getByText(/has not published an approved plan/i)).toBeVisible();
  await expect(patientMain.getByText(HINDI)).toHaveCount(0);
  await expect(patientMain.getByText(/suggestion|extraction|variant|rendering/i)).toHaveCount(0);
  await expect(patientMain.getByRole('link', { name: /task|reminder|schedule/i })).toHaveCount(0);

  // ------------------------------------------------- one viewport at six sizes
  for (const size of VIEWPORTS) {
    for (const [target, label, tab, panel] of [
      [page, 'coordinator extraction', 'Extraction', 'Decision'],
      [page, 'coordinator language', 'Language', null],
      [reviewerPage, 'reviewer language', 'Language', null],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await target.setViewportSize(FULL);
      // eslint-disable-next-line no-await-in-loop
      await planTab(target, tab).click();
      if (panel) {
        // eslint-disable-next-line no-await-in-loop
        await suggestionPanel(target, panel).click();
      }
      // eslint-disable-next-line no-await-in-loop
      await target.setViewportSize({ width: size.width, height: size.height });
      // eslint-disable-next-line no-await-in-loop
      await measureOneViewport(target, `${label} @ ${size.name}`);
    }
  }

  await coordinator.close();
  await reviewer.close();
  await patient.close();
});

test('with no provider enabled the extraction screen fails closed and drafting by hand still works', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  test.skip(
    process.env.EXTRACTION_PROVIDER === 'fake',
    'this journey runs only with the provider DISABLED (the shipped default)'
  );

  const coordinator = await browser.newContext({
    storageState: session('plan-coordinator.json'),
    viewport: FULL,
  });
  const page = await coordinator.newPage();
  await openEpisode(page, EPISODE);
  // A job still targets a draft version, so one has to exist for this journey.
  await page.getByRole('button', { name: 'New draft version' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Create draft version' }).click();
  await expect(page.getByText('Draft version created.')).toBeVisible();

  await planTab(page, 'Extraction').click();

  await page.getByLabel('Ready document').selectOption({ label: SOURCE_FILE });
  await page.getByRole('button', { name: 'Start extraction job' }).click();
  await page.getByRole('button', { name: 'Run extraction job' }).click();

  await expect(page.getByText(/Draft this plan by hand/i).first()).toBeVisible();
  await expect(page.getByText(/the manual workflow is still available/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply to draft' })).toHaveCount(0);

  // The manual path is entirely unaffected.
  await planTab(page, 'Draft').click();
  await expect(page.getByRole('button', { name: 'Add item' })).toBeEnabled();

  await coordinator.close();
});
