'use strict';

// Part 2 browser journey: a coordinator onboards a patient through the stepped
// wizard, records consent, activates the record and invites a caregiver - all
// through the real UI against the real API. Synthetic data only.
//
// This uses the dedicated `flow@synthetic.invalid` coordinator so it never
// collides with auth.spec's one-time MFA enrollment (global-setup resets MFA
// for every synthetic account before the run).
const { test, expect } = require('@playwright/test');
const { signInThroughMfa } = require('./helpers');

const FLOW_USER = 'flow@synthetic.invalid';

test('a coordinator onboards, consents, activates a patient and invites a caregiver', async ({ page }) => {
  await signInThroughMfa(page, FLOW_USER);

  await page.getByRole('link', { name: 'Patients' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Patients' })).toBeVisible();

  // Stepped creation wizard.
  await page.getByRole('button', { name: 'New patient' }).click();
  await page.getByLabel('Full name').fill('Synthetic Journey Patient');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Review' })).toBeVisible();
  await page.getByRole('button', { name: 'Create patient' }).click();

  // The detail view opens on the created patient.
  await expect(page.getByRole('heading', { level: 1, name: 'Synthetic Journey Patient' })).toBeVisible();

  // Activation is refused until consent exists.
  await page.getByRole('button', { name: 'Activate patient' }).click();
  await expect(page.getByRole('alert')).toContainText(/consent/i);

  // Record care-coordination consent.
  await page.getByRole('tab', { name: 'Consent' }).click();
  await page.getByLabel('Purpose').fill('care coordination');
  await page.getByRole('button', { name: 'Record consent' }).click();
  await expect(page.getByText('Consent recorded.')).toBeVisible();

  // The creator is already the active assignee, so activation now succeeds.
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Activate patient' }).click();
  await expect(page.getByText('Patient activated.')).toBeVisible();

  // Invite a caregiver; the one-time link is surfaced because no mail provider
  // is authorised yet.
  await page.getByRole('tab', { name: 'Caregivers' }).click();
  await page.getByLabel('Caregiver email').fill('caregiver.flow@synthetic.invalid');
  await page.getByRole('button', { name: 'Invite caregiver' }).click();
  await expect(page.getByText(/Invitation link:/)).toBeVisible();

  // Control #25: the detail screen still fits one viewport with no page scroll.
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollHeight - window.innerHeight;
  });
  expect(overflow).toBeLessThanOrEqual(2);
});
