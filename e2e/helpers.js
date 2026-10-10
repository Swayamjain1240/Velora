'use strict';

// Shared browser-journey helpers. Everything here uses the synthetic seed
// identities only (server/scripts/seed.js) - never real data.
const otpauth = require('otpauth');

const SEED_PASSWORD = 'SyntheticDevPass!24';

// Six required viewport sizes (VEL-017). Name -> CSS pixels.
const VIEWPORTS = [
  { name: 'desktop 1440x900', width: 1440, height: 900 },
  { name: 'tablet 768x1024', width: 768, height: 1024 },
  { name: 'mobile 390x844', width: 390, height: 844 },
  { name: 'small mobile 320x568', width: 320, height: 568 },
  { name: 'landscape 844x390', width: 844, height: 390 },
  { name: 'short 320x400', width: 320, height: 400 },
];

function totp(secretBase32, account) {
  const totpGen = new otpauth.TOTP({
    issuer: 'Velora',
    label: account,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: otpauth.Secret.fromBase32(secretBase32),
  });
  return totpGen.generate();
}

// Drives the real browser login -> forced MFA enrollment -> dashboard journey.
// Returns the TOTP secret that was enrolled.
async function signInThroughMfa(page, email, account = email) {
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', SEED_PASSWORD);
  await page.click('button[type="submit"]');

  // Staff without MFA are forced to enrol before any protected route.
  await page.waitForURL('**/login/enroll');
  const secret = (await page.textContent('[data-testid="mfa-secret"]')).trim();

  await page.fill('#code', totp(secret, account));
  await page.click('button[type="submit"]');

  // Recovery codes are shown exactly once, then the user continues into /app.
  await page.waitForSelector('.recovery-codes');
  await page.getByRole('button', { name: /I have saved them/i }).click();
  await page.waitForURL('**/app');
  return secret;
}

// Produces an already-enrolled cookie session via the API, so viewport tests do
// not repeat the enrollment UI (and avoid re-running the login rate limit).
async function enrolledStorageState(request, email, account = email) {
  const login = await request.post('/api/auth/login', {
    data: { email, password: SEED_PASSWORD },
  });
  const loginBody = await login.json();
  if (loginBody.next !== 'mfa_enroll') {
    throw new Error(`expected mfa_enroll, got ${JSON.stringify(loginBody)}`);
  }
  const csrf = await csrfFromRequest(request);

  const setup = await request.post('/api/auth/mfa/enroll/setup', {
    headers: { 'X-CSRF-Token': csrf },
  });
  const { secretBase32 } = await setup.json();

  const verify = await request.post('/api/auth/mfa/enroll/verify', {
    headers: { 'X-CSRF-Token': csrf },
    data: { code: totp(secretBase32, account) },
  });
  if (!verify.ok()) throw new Error(`enroll verify failed: ${verify.status()}`);

  return request.storageState();
}

async function csrfFromRequest(request) {
  const state = await request.storageState();
  const cookie = state.cookies.find((c) => c.name === 'velora_csrf');
  if (!cookie) throw new Error('no velora_csrf cookie on the request context');
  return cookie.value;
}

// Height of the document relative to the viewport. Returns the overflow in
// pixels (0 means the page fits).
async function pageOverflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollHeight: doc.scrollHeight,
      innerHeight: window.innerHeight,
      overflow: doc.scrollHeight - window.innerHeight,
      bodyOverflow: getComputedStyle(document.body).overflowY,
    };
  });
}

module.exports = { SEED_PASSWORD, VIEWPORTS, totp, signInThroughMfa, enrolledStorageState, csrfFromRequest, pageOverflow };
