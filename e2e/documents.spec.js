'use strict';

// Part 4 browser journeys against the real API and real encrypted storage.
//
// Synthetic files only. Each journey uploads a fabricated PDF that differs by a
// token, so every upload is byte-unique (the server stores one object per
// episode + checksum) and the newest row is unambiguous.
//
// The sessions come from e2e/global-setup.js: `docs-coordinator.json` is the
// coordinator who is an ACTIVE care-team member on the seeded episodes, and
// `docs-patient.json` is the synthetic patient whose profile is linked to
// EP-DOCSPAT. Both are enrolled through the API there, so no journey here
// repeats the one-time MFA enrollment (auth.spec owns that).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { VIEWPORTS } = require('./helpers');

// Every upload in this file is byte- and name-unique per run, so a leftover
// document from an earlier run can never make a row locator ambiguous.
const RUN = Date.now().toString(36);

const DRAFT_EPISODE = 'EP-DOCSDRAFT';
const CLOSED_EPISODE = 'EP-DOCCLOSED';
const PATIENT_EPISODE = 'EP-DOCSPAT';

function session(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '.auth', file), 'utf8'));
}

function pdfBody(token) {
  return [
    '1 0 obj',
    '<< /Type /Catalog /Pages 2 0 R >>',
    'endobj',
    '2 0 obj',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    'endobj',
    '3 0 obj',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
    'endobj',
    `% synthetic token ${token}`,
    'trailer',
    '<< /Size 4 /Root 1 0 R >>',
    'startxref',
    '0',
    '%%EOF',
    '',
  ].join('\n');
}

// A technically acceptable one-page PDF.
function pdfBytes(token) {
  return Buffer.from(`%PDF-1.4\n${pdfBody(token)}`, 'latin1');
}

// A PDF carrying a script action: the parser must refuse it structurally.
function activePdfBytes(token) {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert) >> >>\nendobj\n` +
      `% synthetic token ${token}\n` +
      `trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n`,
    'latin1'
  );
}

async function openEpisode(page, reference) {
  await page.goto('/app/episodes');
  await expect(page.getByRole('heading', { level: 1, name: 'Recovery episodes' })).toBeVisible();
  await page.getByRole('row', { name: new RegExp(reference) }).getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { level: 1, name: reference })).toBeVisible();
  await page.getByRole('tab', { name: 'Documents' }).click();
}

async function openPatientEpisode(page, reference) {
  await page.goto('/app/me/episodes');
  await expect(page.getByRole('heading', { level: 1, name: 'My recovery episodes' })).toBeVisible();
  await page.getByRole('row', { name: new RegExp(reference) }).getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { level: 1, name: reference })).toBeVisible();
}

// choose -> review -> upload -> result, then download and compare the bytes.
async function uploadAndDownload(page, { filename, bytes }) {
  await page.getByRole('button', { name: 'Upload document' }).click();
  await page.setInputFiles('#doc-file', {
    name: filename,
    mimeType: 'application/pdf',
    buffer: bytes,
  });

  // Review step shows exactly what will be sent, before anything is uploaded.
  await expect(page.getByRole('heading', { name: 'Review' })).toBeVisible();
  await expect(page.locator('.wizard').getByText(filename)).toBeVisible();

  await page.getByRole('button', { name: 'Upload document' }).click();
  // Scope to the wizard: the list behind it shows the same status wording.
  const wizard = page.locator('.wizard');
  await expect(wizard.getByText(/Technically accepted for later review/)).toBeVisible();
  await expect(wizard.getByText(/This is not clinical approval/)).toBeVisible();

  await page.getByRole('button', { name: 'Done' }).click();

  const row = page.getByRole('row', { name: new RegExp(filename.replace(/\./g, '\\.')) });
  await expect(row.getByText('Ready for review')).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await row.getByRole('button', { name: 'Download' }).click();
  const download = await downloadPromise;
  const saved = path.join(os.tmpdir(), `velora-e2e-${filename}`);
  await download.saveAs(saved);

  // The bytes a reviewer receives must be identical to the uploaded original.
  return { downloaded: fs.readFileSync(saved), suggested: download.suggestedFilename() };
}

for (const size of VIEWPORTS) {
  test(`a document uploads, is marked technical review only, and downloads byte-for-byte at ${size.name}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: session('docs-coordinator.json'),
      viewport: { width: 1440, height: 900 },
      acceptDownloads: true,
    });
    const page = await context.newPage();

    // Opening the episode uses the Part 3 list, already covered at every size by
    // viewports.spec; the DOCUMENT journey below runs at the required size.
    await openEpisode(page, DRAFT_EPISODE);
    await page.setViewportSize({ width: size.width, height: size.height });

    const filename = `discharge-${size.name.replace(/\W+/g, '-')}-${RUN}.pdf`;
    const bytes = pdfBytes(`${size.name} ${RUN} ${Date.now()}`);
    const { downloaded, suggested } = await uploadAndDownload(page, { filename, bytes });

    expect(suggested).toBe(filename);
    expect(Buffer.compare(downloaded, bytes)).toBe(0);
    await expect(page.getByText('Download started.')).toBeVisible();

    // Control #25: the whole document screen still fits one viewport, with no
    // page-level scrolling, at every required size.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight
    );
    expect(overflow, `${size.name} overflows the viewport`).toBeLessThanOrEqual(2);

    await context.close();
  });
}

test('an active PDF is refused, a closed episode is read-only, and a patient cannot upload', async ({ browser }) => {
  const staff = await browser.newContext({
    storageState: session('docs-coordinator.json'),
    viewport: { width: 1440, height: 900 },
  });
  const page = await staff.newPage();

  // ---- A PDF with a JavaScript action is refused and never stored as ready ----
  await openEpisode(page, DRAFT_EPISODE);
  await page.getByRole('button', { name: 'Upload document' }).click();
  const rejectedName = `active-content-${RUN}.pdf`;
  await page.setInputFiles('#doc-file', {
    name: rejectedName,
    mimeType: 'application/pdf',
    buffer: activePdfBytes(`active ${RUN} ${Date.now()}`),
  });
  await page.getByRole('button', { name: 'Upload document' }).click();

  await expect(page.locator('.wizard').getByText('Rejected', { exact: true })).toBeVisible();
  await expect(page.getByText(/Reason code: pdf active content/)).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  const rejectedRow = page.getByRole('row', { name: new RegExp(rejectedName.replace(/\./g, '\\.')) });
  await expect(rejectedRow.getByText('The file was refused and no copy was kept.')).toBeVisible();
  await expect(rejectedRow.getByText('Not downloadable')).toBeVisible();

  // ---- A closed episode accepts no documents at all ----
  await openEpisode(page, CLOSED_EPISODE);
  await expect(page.getByText(/only be added while the episode is a draft/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upload document' })).toHaveCount(0);

  await staff.close();

  // ---- A patient reads and downloads, but can never upload ----
  const patient = await browser.newContext({
    storageState: session('docs-patient.json'),
    viewport: { width: 390, height: 844 },
  });
  const patientPage = await patient.newPage();
  await openPatientEpisode(patientPage, PATIENT_EPISODE);

  await expect(patientPage.getByText('Only your care team can upload documents.')).toBeVisible();
  await expect(patientPage.getByRole('button', { name: 'Upload document' })).toHaveCount(0);
  await expect(patientPage.getByText(/No documents have been uploaded/)).toBeVisible();

  const overflow = await patientPage.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight
  );
  expect(overflow, 'the patient document screen overflows the viewport').toBeLessThanOrEqual(2);

  await patient.close();
});
