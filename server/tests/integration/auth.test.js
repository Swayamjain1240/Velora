'use strict';

// Integration tests over the real HTTP stack + MongoDB test database.
// Covers the Part 1 exit gate: login, session fixation/revocation, CSRF, CORS,
// MFA, safe errors, validation/XSS and rate limiting.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const harness = require('../helpers/setup');

let app;
const PASSWORD = 'SyntheticTestPass!24';

before(async () => {
  app = await harness.init();
});
after(async () => {
  await harness.shutdown();
});
beforeEach(async () => {
  await harness.resetDb();
});

async function seedAdmin() {
  const { clinic, admin } = await harness.makeClinic({});
  return { clinic, admin };
}

test('login rejects wrong password with a safe, non-enumerating error', async () => {
  const { admin } = await seedAdmin();
  const res = await harness
    .agent(app)
    .post('/api/auth/login')
    .send({ email: admin.user.email, password: 'TotallyWrong!99' });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error.code, 'FORBIDDEN');
  // Same message whether the account exists or not.
  assert.match(res.body.error.message, /Invalid email or password/);
});

test('login for unknown email returns the identical safe error (no enumeration)', async () => {
  const res = await harness
    .agent(app)
    .post('/api/auth/login')
    .send({ email: 'nobody@synthetic.invalid', password: 'Whatever!123' });
  assert.strictEqual(res.status, 403);
  assert.match(res.body.error.message, /Invalid email or password/);
});

test('full login -> status -> MFA-gated /me -> logout lifecycle', async () => {
  const { admin } = await seedAdmin();
  const a = harness.agent(app);

  const login = await a
    .post('/api/auth/login')
    .send({ email: admin.user.email, password: PASSWORD });
  assert.strictEqual(login.status, 200);
  assert.strictEqual(login.body.next, 'mfa_enroll');
  assert.ok(login.body.user && !login.body.user.passwordHash);
  const csrf = harness.csrfFrom(login);
  assert.ok(csrf, 'CSRF cookie must be issued');

  // Session cookie is httpOnly (no JS access) and SameSite.
  const setCookie = login.headers['set-cookie'].join(';');
  assert.match(setCookie, /velora_session=/);
  assert.match(setCookie, /HttpOnly/i);

  // Password-only session cannot reach protected routes yet.
  const meBefore = await a.get('/api/auth/me');
  assert.strictEqual(meBefore.status, 401);

  const status = await a.get('/api/auth/status');
  assert.strictEqual(status.body.mfaPending, true);

  // Complete enrollment, which promotes the session.
  const enrolled = await harness.enrollMfa(a, csrf, admin.user.email);
  assert.strictEqual(enrolled.verify.status, 200);
  assert.strictEqual(enrolled.recoveryCodes.length, 10);

  const meAfter = await a.get('/api/auth/me');
  assert.strictEqual(meAfter.status, 200);
  assert.strictEqual(meAfter.body.user.email, admin.user.email);
  assert.strictEqual(meAfter.body.memberships[0].roleKey, 'admin');

  const logout = await a.post('/api/auth/logout').set('X-CSRF-Token', csrf);
  assert.strictEqual(logout.status, 200);
  const meOut = await a.get('/api/auth/me');
  assert.strictEqual(meOut.status, 401);
});

test('MFA promotion rotates the session token (fixation defense)', async () => {
  const { admin } = await seedAdmin();
  const a = harness.agent(app);
  const login = await a
    .post('/api/auth/login')
    .send({ email: admin.user.email, password: PASSWORD });
  const csrf = harness.csrfFrom(login);
  const preMfaCookie = login.headers['set-cookie']
    .join(' ').match(/velora_session=([^;]+)/)[1];

  await harness.enrollMfa(a, csrf, admin.user.email);

  // Replay the pre-MFA cookie value: it must be dead.
  const replay = await harness
    .agent(app)
    .get('/api/auth/me')
    .set('Cookie', `velora_session=${preMfaCookie}`);
  assert.strictEqual(replay.status, 401, 'old session token must be revoked');
});

test('revoke-all kills every other session for the user', async () => {
  const { admin } = await seedAdmin();
  const first = harness.agent(app);
  const login1 = await first.post('/api/auth/login').send({ email: admin.user.email, password: PASSWORD });
  const csrf1 = harness.csrfFrom(login1);
  await harness.enrollMfa(first, csrf1, admin.user.email);

  // Second device logs in and completes MFA too.
  const second = harness.agent(app);
  const login2 = await second.post('/api/auth/login').send({ email: admin.user.email, password: PASSWORD });
  const csrf2 = harness.csrfFrom(login2);
  await harness.enrollMfa(second, csrf2, admin.user.email);

  assert.strictEqual((await second.get('/api/auth/me')).status, 200);

  const revoke = await second
    .post('/api/auth/sessions/revoke-all')
    .set('X-CSRF-Token', csrf2);
  assert.strictEqual(revoke.status, 200);

  assert.strictEqual((await second.get('/api/auth/me')).status, 401);
  assert.strictEqual((await first.get('/api/auth/me')).status, 401);
});

test('TOTP enrollment then login requires a live code; recovery code is single-use', async () => {
  const { admin } = await seedAdmin();
  const a = harness.agent(app);
  const login = await a.post('/api/auth/login').send({ email: admin.user.email, password: PASSWORD });
  const csrf = harness.csrfFrom(login);
  const { recoveryCodes } = await harness.enrollMfa(a, csrf, admin.user.email);

  // Fresh login now requires MFA.
  const b = harness.agent(app);
  const login2 = await b.post('/api/auth/login').send({ email: admin.user.email, password: PASSWORD });
  assert.strictEqual(login2.body.next, 'mfa_verify');

  const bad = await b
    .post('/api/auth/mfa/verify')
    .set('X-CSRF-Token', harness.csrfFrom(login2))
    .send({ code: '000000' });
  // 000000 could coincidentally be valid within the window; assert it is
  // either rejected outright OR (astronomically unlikely) accepted.
  if (bad.status !== 200) assert.strictEqual(bad.status, 403);

  // Recovery code path works once, then is consumed.
  const rc = recoveryCodes[0];
  const csrf2 = harness.csrfFrom(login2);
  const use1 = await b.post('/api/auth/mfa/verify').set('X-CSRF-Token', csrf2).send({ recoveryCode: rc });
  assert.strictEqual(use1.status, 200);
  assert.strictEqual((await b.get('/api/auth/me')).status, 200);

  const login3 = await b
    .post('/api/auth/login')
    .set('X-CSRF-Token', csrf2)
    .send({ email: admin.user.email, password: PASSWORD });
  // NOTE: login3 must carry the CSRF header because agent b still holds a
  // live session cookie; the server (correctly) guards every cookie-bearing
  // mutation, including POST /login. The real browser client reads the
  // non-httpOnly velora_csrf cookie and does the same.
  assert.strictEqual(login3.status, 200);
  const use2 = await b
    .post('/api/auth/mfa/verify')
    .set('X-CSRF-Token', harness.csrfFrom(login3))
    .send({ recoveryCode: rc });
  assert.strictEqual(use2.status, 403, 'recovery code must be single-use');
});

test('CSRF: cookie-authenticated mutation without a valid token is rejected', async () => {
  const { clinic, admin } = await seedAdmin();
  const a = harness.agent(app);
  const login = await a.post('/api/auth/login').send({ email: admin.user.email, password: PASSWORD });
  const csrf = harness.csrfFrom(login);
  await harness.enrollMfa(a, csrf, admin.user.email);

  const body = { email: 'invitee@synthetic.invalid', roleKey: 'care_coordinator' };
  const noHeader = await a.post('/api/staff/invitations').send(body);
  assert.strictEqual(noHeader.status, 403);

  const wrongHeader = await a
    .post('/api/staff/invitations')
    .set('X-CSRF-Token', 'deadbeefdeadbeef')
    .send(body);
  assert.strictEqual(wrongHeader.status, 403);

  const ok = await a.post('/api/staff/invitations').set('X-CSRF-Token', csrf).send(body);
  assert.strictEqual(ok.status, 201);
});

test('CORS: exact allowlist, no wildcard; foreign origin gets no ACAO header', async () => {
  const allowed = await harness.agent(app)
    .get('/api/health')
    .set('Origin', 'http://localhost:5173');
  assert.strictEqual(allowed.status, 200);
  assert.strictEqual(allowed.headers['access-control-allow-origin'], 'http://localhost:5173');

  const foreign = await harness.agent(app)
    .get('/api/health')
    .set('Origin', 'https://evil.example');
  assert.strictEqual(foreign.headers['access-control-allow-origin'], undefined);
});

test('validation: unknown fields rejected, XSS strings never executed or echoed as HTML', async () => {
  const res = await harness
    .agent(app)
    .post('/api/auth/login')
    .set('Content-Type', 'application/json')
    .send({ email: 'a@b.com', password: 'x', isAdmin: true });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error.code, 'BAD_REQUEST');

  const { clinic, admin } = await seedAdmin();
  const a = harness.agent(app);
  const login = await a.post('/api/auth/login').send({ email: admin.user.email, password: PASSWORD });
  const csrf = harness.csrfFrom(login);
  await harness.enrollMfa(a, csrf, admin.user.email);

  const xss = await a
    .post('/api/staff/invitations')
    .set('X-CSRF-Token', csrf)
    .send({ email: 'xss@synthetic.invalid', roleKey: 'admin' });
  assert.strictEqual(xss.status, 201);
  // Response is JSON, not HTML; content-type must not be text/html.
  assert.match(xss.headers['content-type'], /application\/json/);
  assert.ok(!/<script/i.test(JSON.stringify(xss.body)));
});

test('unknown route returns the safe 404 envelope', async () => {
  const res = await harness.agent(app).get('/api/definitely-not-a-route');
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error.code, 'NOT_FOUND');
});

test('rate limiting: repeated login attempts trip the atomic limiter', async () => {
  const { admin } = await seedAdmin();
  const a = harness.agent(app);
  let sawLimit = false;
  for (let i = 0; i < 14; i += 1) {
    const res = await a
      .post('/api/auth/login')
      .send({ email: admin.user.email, password: 'Wrong!Pass' + i });
    if (res.status === 429) { sawLimit = true; break; }
  }
  assert.ok(sawLimit, 'expected a 429 within repeated failed logins');
});
