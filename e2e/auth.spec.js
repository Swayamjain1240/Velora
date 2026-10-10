'use strict';

// Part 1 browser journeys: landing, forced staff MFA enrollment, safe error
// handling and the protected-route redirect. Synthetic data only.
//
// global-setup enrols the admin and reviewer accounts (to feed the viewport
// spec), so this file uses the coordinator for the one-time enrollment journey
// and signs THAT session out, never the shared ones.
const { test, expect } = require('@playwright/test');
const { signInThroughMfa } = require('./helpers');

const ENROLL_USER = 'coordinator@synthetic.invalid';

test('landing page renders the product and its safety boundaries', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Velora' })).toBeVisible();
  await expect(page.getByText(/does not diagnose or prescribe/i)).toBeVisible();
  await expect(page.getByText(/AI output is never published automatically/i)).toBeVisible();
});

test('staff sign-in forces MFA enrollment, reaches the dashboard, then sign-out revokes access', async ({ page }) => {
  await signInThroughMfa(page, ENROLL_USER);

  // Dashboard is inside the authenticated shell.
  await expect(page.getByRole('navigation', { name: 'Application' })).toBeVisible();

  // Sign out revokes this session, and /app is no longer reachable.
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.waitForURL('**/login');
  await page.goto('/app');
  await page.waitForURL('**/login');
  await expect(page.getByRole('heading', { name: /staff sign in/i })).toBeVisible();
});

test('invalid credentials show the safe error and stay on /login', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#email', 'nobody@synthetic.invalid');
  await page.fill('#password', 'definitely-not-the-password');
  await page.click('button[type="submit"]');

  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  // Safe message: no "user not found" vs "wrong password" distinction.
  await expect(alert).toContainText(/invalid email or password/i);
  await expect(page).toHaveURL(/\/login$/);
});

test('an unauthenticated visit to /app is redirected to /login', async ({ page }) => {
  await page.goto('/app');
  await page.waitForURL('**/login');
  await expect(page.getByRole('heading', { name: /staff sign in/i })).toBeVisible();
});
