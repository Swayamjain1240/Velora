'use strict';

// The quarantine journey, opt-in because it needs an API started with a tiny
// parser wall-clock budget (the shipped 3000 ms is far too generous to time out
// on a healthy host):
//
//   PORT=4000 NODE_ENV=test DOCUMENT_PARSER_TIMEOUT_MS=50 node server/src/index.js
//   E2E_QUARANTINE=1 npx playwright test e2e/documents-quarantine.spec.js
//
// Without E2E_QUARANTINE=1 the journey is reported as skipped, so the default
// `npx playwright test` run against the normal API stays meaningful. The file
// uploaded here is STRUCTURALLY VALID - nothing about it is suspect - so the
// wall-clock limit is the only reason it can be held, which is exactly the
// "held for an operator, never marked ready" path control #8/#9 requires.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const ENABLED = process.env.E2E_QUARANTINE === '1';
const DRAFT_EPISODE = 'EP-DOCSDRAFT';

function session(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '.auth', file), 'utf8'));
}

// A structurally valid PDF padded with one large comment: three objects, one
// page, no active content, nothing appended after %%EOF.
function largeValidPdfBytes(token) {
  return Buffer.from(
    `%PDF-1.4\n` +
      `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
      `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n` +
      `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n` +
      `% ${'S'.repeat(2_000_000)}\n` +
      `% synthetic token ${token}\n` +
      `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n`,
    'latin1'
  );
}

test.skip(
  !ENABLED,
  'requires an API started with DOCUMENT_PARSER_TIMEOUT_MS=50 (see the file header)'
);

test('a parser that cannot finish in time quarantines the document and offers no download', async ({
  browser,
}) => {
  const context = await browser.newContext({
    storageState: session('docs-coordinator.json'),
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  await page.goto('/app/episodes');
  await page
    .getByRole('row', { name: new RegExp(DRAFT_EPISODE) })
    .getByRole('button', { name: 'Open' })
    .click();
  await page.getByRole('tab', { name: 'Documents' }).click();

  const filename = `held-${Date.now()}.pdf`;
  const bytes = largeValidPdfBytes(String(Date.now()));

  await page.getByRole('button', { name: 'Upload document' }).click();
  await page.setInputFiles('#doc-file', {
    name: filename,
    mimeType: 'application/pdf',
    buffer: bytes,
  });
  await page.getByRole('button', { name: 'Upload document' }).click();

  const wizard = page.locator('.wizard');
  await expect(wizard.getByText('Quarantined')).toBeVisible({ timeout: 30_000 });
  await expect(wizard.getByText(/held privately for an operator/i)).toBeVisible();
  // A held file is never presented as accepted for review.
  await expect(wizard.getByText(/Technically accepted for later review/)).toHaveCount(0);

  await page.getByRole('button', { name: 'Done' }).click();
  const row = page.getByRole('row', { name: new RegExp(filename.replace(/\./g, '\\.')) });
  await expect(row.getByText('Quarantined')).toBeVisible();
  await expect(row.getByText('Not downloadable', { exact: true })).toBeVisible();

  await context.close();
});
