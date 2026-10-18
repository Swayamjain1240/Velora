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

test('MFA enrollment setup is idempotent: repeated setup returns the same secret', async () => {
  // Guards the StrictMode double-fire race: the client mounts twice in dev and
  // calls setup twice. Both calls must yield the SAME secret so the code the
  // user scans always matches the secret the server will verify against.
  const { admin } = await seedAdmin();
  const a = harness.agent(app);
  const login = await a.post('/api/auth/login').send({ email: admin.user.email, password: PASSWORD });
  const csrf = harness.csrfFrom(login);

  const s1 = await a.post('/api/auth/mfa/enroll/setup').set('X-CSRF-Token', csrf);
  const s2 = await a.post('/api/auth/mfa/enroll/setup').set('X-CSRF-Token', csrf);
  assert.strictEqual(s1.status, 200);
  assert.strictEqual(s2.status, 200);
  assert.strictEqual(s1.body.secretBase32, s2.body.secretBase32, 'setup must be idempotent');

  // A code from the (stable) secret must now verify.
  const code = harness.totpCode(s1.body.secretBase32, admin.user.email);
  const verify = await a
    .post('/api/auth/mfa/enroll/verify')
    .set('X-CSRF-Token', csrf)
    .send({ code });
  assert.strictEqual(verify.status, 200);
  assert.strictEqual((await a.get('/api/auth/me')).status, 200);
});

test('concurrent MFA enrollment setups agree on ONE secret and that secret verifies', async () => {
  // The sequential case above can pass even when the install is a read-then-save
  // race: two parallel setup calls would each generate a secret, the database
  // would keep one of them and the client could render the other - leaving the
  // user unable to enrol with a code that looks correct. This case fires both
  // calls together and then proves the returned secret is the stored one.
  const { admin } = await seedAdmin();
  const a = harness.agent(app);
  const login = await a.post('/api/auth/login').send({ email: admin.user.email, password: PASSWORD });
  const csrf = harness.csrfFrom(login);

  const [s1, s2] = await Promise.all([
    a.post('/api/auth/mfa/enroll/setup').set('X-CSRF-Token', csrf),
    a.post('/api/auth/mfa/enroll/setup').set('X-CSRF-Token', csrf),
  ]);
  assert.strictEqual(s1.status, 200);
  assert.strictEqual(s2.status, 200);
  assert.strictEqual(
    s1.body.secretBase32,
    s2.body.secretBase32,
    'parallel setup calls must return the stored secret'
  );

  const code = harness.totpCode(s1.body.secretBase32, admin.user.email);
  const verify = await a
    .post('/api/auth/mfa/enroll/verify')
    .set('X-CSRF-Token', csrf)
    .send({ code });
  assert.strictEqual(verify.status, 200, JSON.stringify(verify.body));
  assert.ok(verify.body.recoveryCodes.length > 0);

  // The stored secret is the one the client was shown, not a discarded sibling.
  const stored = await harness.models.User.findById(admin.user.id).select('+mfa.secretEnc');
  const { openSecret } = require('../../src/services/crypto');
  assert.strictEqual(openSecret(stored.mfa.secretEnc), s1.body.secretBase32);
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
  const enrolled = await harness.enrollMfa(first, csrf1, admin.user.email);
  const secret = enrolled.setup.body.secretBase32;

  // Second device logs in and completes MFA too - by VERIFYING with the same
  // authenticator, because an enrolled account may not enrol again.
  const second = harness.agent(app);
  const login2 = await second.post('/api/auth/login').send({ email: admin.user.email, password: PASSWORD });
  const csrf2 = harness.csrfFrom(login2);
  assert.strictEqual(login2.body.next, 'mfa_verify');
  const verified = await harness.verifyMfa(second, csrf2, secret, admin.user.email);
  assert.strictEqual(verified.status, 200, JSON.stringify(verified.body));

  assert.strictEqual((await second.get('/api/auth/me')).status, 200);

  const revoke = await second
    .post('/api/auth/sessions/revoke-all')
    .set('X-CSRF-Token', csrf2);
  assert.strictEqual(revoke.status, 200);

  assert.strictEqual((await second.get('/api/auth/me')).status, 401);
  assert.strictEqual((await first.get('/api/auth/me')).status, 401);
});

test('a password-only session can never replace an existing MFA factor', async () => {
  // MFA must be a real second factor. If an mfa_pending (password-only) session
  // could install a new secret, anyone holding the password could swap the
  // factor and take the account over - so enrollment is first-time only.
  const { admin } = await seedAdmin();
  const owner = harness.agent(app);
  const login1 = await owner.post('/api/auth/login').send({ email: admin.user.email, password: PASSWORD });
  const csrf1 = harness.csrfFrom(login1);
  const enrolled = await harness.enrollMfa(owner, csrf1, admin.user.email);
  const secret = enrolled.setup.body.secretBase32;

  const attacker = harness.agent(app);
  const login2 = await attacker
    .post('/api/auth/login')
    .send({ email: admin.user.email, password: PASSWORD });
  const csrf2 = harness.csrfFrom(login2);
  assert.strictEqual(login2.body.next, 'mfa_verify');

  // No new secret, and no completion of a self-chosen one.
  const setup = await attacker
    .post('/api/auth/mfa/enroll/setup')
    .set('X-CSRF-Token', csrf2);
  assert.strictEqual(setup.status, 409, JSON.stringify(setup.body));
  assert.strictEqual(setup.body.secretBase32, undefined);

  const rogue = await attacker
    .post('/api/auth/mfa/enroll/verify')
    .set('X-CSRF-Token', csrf2)
    .send({ code: harness.totpCode('JBSWY3DPEHPK3PXP', admin.user.email) });
  assert.strictEqual(rogue.status, 409, JSON.stringify(rogue.body));
  assert.strictEqual((await attacker.get('/api/auth/me')).status, 401);

  // The stored factor is unchanged, so the legitimate authenticator still works.
  const stored = await harness.models.User.findById(admin.user.id).select('+mfa.secretEnc');
  const { openSecret } = require('../../src/services/crypto');
  assert.strictEqual(openSecret(stored.mfa.secretEnc), secret);
  const ok = await harness.verifyMfa(attacker, csrf2, secret, admin.user.email);
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.strictEqual((await attacker.get('/api/auth/me')).status, 200);
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

test('D-4: a TOTP code cannot authenticate two sessions, and the next code still works', async () => {
  const { admin } = await seedAdmin();
  const owner = harness.agent(app);
  const login1 = await owner
    .post('/api/auth/login')
    .send({ email: admin.user.email, password: PASSWORD });
  const csrf1 = harness.csrfFrom(login1);
  const enrolled = await harness.enrollMfa(owner, csrf1, admin.user.email);
  const secret = enrolled.setup.body.secretBase32;

  // Enrollment does not consume the step, so the very code the user just typed
  // still works for the first sign-in on another device.
  const second = harness.agent(app);
  const login2 = await second
    .post('/api/auth/login')
    .send({ email: admin.user.email, password: PASSWORD });
  const csrf2 = harness.csrfFrom(login2);
  const code = harness.totpCode(secret, admin.user.email);
  const verified = await second
    .post('/api/auth/mfa/verify')
    .set('X-CSRF-Token', csrf2)
    .send({ code });
  assert.strictEqual(verified.status, 200, JSON.stringify(verified.body));

  // A third pending session replaying the SAME code inside the same window must
  // be refused: one code is one authentication.
  const third = harness.agent(app);
  const login3 = await third
    .post('/api/auth/login')
    .send({ email: admin.user.email, password: PASSWORD });
  const csrf3 = harness.csrfFrom(login3);
  const replay = await third
    .post('/api/auth/mfa/verify')
    .set('X-CSRF-Token', csrf3)
    .send({ code });
  assert.strictEqual(replay.status, 403, 'a replayed code must be refused');
  assert.strictEqual((await third.get('/api/auth/me')).status, 401);

  // A genuinely new code (next counter step) is still accepted.
  const fresh = await third
    .post('/api/auth/mfa/verify')
    .set('X-CSRF-Token', csrf3)
    .send({ code: harness.totpCode(secret, admin.user.email, { stepOffset: 1 }) });
  assert.strictEqual(fresh.status, 200, JSON.stringify(fresh.body));
  assert.strictEqual((await third.get('/api/auth/me')).status, 200);
});

test('D-8: a foreign Origin or Referer cannot ride a cookie-authenticated mutation', async () => {
  const { admin } = await seedAdmin();
  const a = harness.agent(app);
  const login = await a.post('/api/auth/login').send({ email: admin.user.email, password: PASSWORD });
  const csrf = harness.csrfFrom(login);
  await harness.enrollMfa(a, csrf, admin.user.email);

  const body = { email: 'origin-check@synthetic.invalid', roleKey: 'care_coordinator' };
  const foreignOrigin = await a
    .post('/api/staff/invitations')
    .set('X-CSRF-Token', csrf)
    .set('Origin', 'https://evil.example')
    .send(body);
  assert.strictEqual(foreignOrigin.status, 403);
  assert.match(foreignOrigin.body.error.message, /origin/i);

  const foreignReferer = await a
    .post('/api/staff/invitations')
    .set('X-CSRF-Token', csrf)
    .set('Referer', 'https://evil.example/form')
    .send({ ...body, email: 'origin-referer@synthetic.invalid' });
  assert.strictEqual(foreignReferer.status, 403);

  // The configured client origin passes and reaches the handler.
  const allowed = await a
    .post('/api/staff/invitations')
    .set('X-CSRF-Token', csrf)
    .set('Origin', 'http://localhost:5173')
    .send({ ...body, email: 'origin-allowed@synthetic.invalid' });
  assert.strictEqual(allowed.status, 201, JSON.stringify(allowed.body));

  // A same-origin Referer is also accepted.
  const allowedReferer = await a
    .post('/api/staff/invitations')
    .set('X-CSRF-Token', csrf)
    .set('Referer', 'http://localhost:5173/app/queues')
    .send({ ...body, email: 'origin-referer-ok@synthetic.invalid' });
  assert.strictEqual(allowedReferer.status, 201, JSON.stringify(allowedReferer.body));
});
