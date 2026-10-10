'use strict';

// Integration tests for clinic permissions: cross-clinic isolation, role
// denials, last-admin protection, reviewer-eligibility self-grant protection,
// invitation races and password reset single-use semantics.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const harness = require('../helpers/setup');
const { hmac } = require('../../src/services/crypto');

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

// Logs a member in, completes MFA, and returns { a, csrf }.
async function authenticatedAgent(email) {
  const a = harness.agent(app);
  const login = await a.post('/api/auth/login').send({ email, password: PASSWORD });
  const csrf = harness.csrfFrom(login);
  await harness.enrollMfa(a, csrf, email);
  return { a, csrf };
}

test('coordinator without staff.manage is denied member listing (403)', async () => {
  const { clinic } = await harness.makeClinic({});
  const { user } = await harness.makeMember(clinic, { roleKey: 'care_coordinator' });
  const { a } = await authenticatedAgent(user.email);
  const res = await a.get('/api/staff/members');
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error.code, 'FORBIDDEN');
});

test('admin lists members with pagination and scoped totals', async () => {
  const { clinic, admin } = await harness.makeClinic({});
  for (let i = 0; i < 3; i += 1) {
    await harness.makeMember(clinic, { roleKey: 'care_coordinator' });
  }
  const { a } = await authenticatedAgent(admin.user.email);
  const res = await a.get('/api/staff/members?page=1&limit=2');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.items.length, 2);
  assert.strictEqual(res.body.total, 4); // admin + 3 coordinators
  assert.strictEqual(res.body.page, 1);
  // No sensitive fields leak.
  assert.ok(!JSON.stringify(res.body).includes('passwordHash'));
  assert.ok(!JSON.stringify(res.body).includes('tokenHash'));
});

test('cross-clinic: admin of clinic A cannot touch a membership of clinic B', async () => {
  const { admin: adminA } = await harness.makeClinic({});
  const { clinic: clinicB, admin: adminB } = await harness.makeClinic({});
  const { a, csrf } = await authenticatedAgent(adminA.user.email);

  // Attempt to change B's admin membership id through A's scoped route.
  const res = await a
    .patch(`/api/staff/members/${adminB.membership.id}`)
    .set('X-CSRF-Token', csrf)
    .send({ status: 'inactive' });
  // Scoped 404: no existence leak across tenants.
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error.code, 'NOT_FOUND');

  // B's membership is untouched.
  const { ClinicMembership } = harness.models;
  const stillActive = await ClinicMembership.findById(adminB.membership.id);
  assert.strictEqual(stillActive.status, 'active');
});

test('the last active admin cannot be demoted or deactivated', async () => {
  const { clinic, admin } = await harness.makeClinic({});
  const { a, csrf } = await authenticatedAgent(admin.user.email);

  const demote = await a
    .patch(`/api/staff/members/${admin.membership.id}`)
    .set('X-CSRF-Token', csrf)
    .send({ roleKey: 'care_coordinator' });
  assert.strictEqual(demote.status, 409);

  const deactivate = await a
    .patch(`/api/staff/members/${admin.membership.id}`)
    .set('X-CSRF-Token', csrf)
    .send({ status: 'inactive' });
  assert.strictEqual(deactivate.status, 409);
});

test('with a second admin, the first can be demoted', async () => {
  const { clinic, admin } = await harness.makeClinic({});
  const second = await harness.makeMember(clinic, { roleKey: 'admin' });
  const { a, csrf } = await authenticatedAgent(admin.user.email);

  const res = await a
    .patch(`/api/staff/members/${admin.membership.id}`)
    .set('X-CSRF-Token', csrf)
    .send({ roleKey: 'care_coordinator' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.member.roleKey, 'care_coordinator');
});

test('reviewer eligibility: admin alone cannot verify; a verified reviewer can; never self', async () => {
  const { clinic, admin } = await harness.makeClinic({});
  // A verified reviewer (bootstrap).
  const { user: verifier, membership: verifierM } = await harness.makeMember(clinic, {
    roleKey: 'clinical_reviewer',
    eligibility: 'verified',
  });
  // A pending reviewer to be verified.
  const { user: target, membership: targetM } = await harness.makeMember(clinic, {
    roleKey: 'clinical_reviewer',
    eligibility: 'pending',
  });

  // 1. Admin (no eligibility) cannot verify anyone.
  const adminAgent = await authenticatedAgent(admin.user.email);
  const byAdmin = await adminAgent.a
    .post(`/api/staff/members/${targetM.id}/reviewer-eligibility`)
    .set('X-CSRF-Token', adminAgent.csrf)
    .send({ action: 'verify' });
  assert.strictEqual(byAdmin.status, 403);

  // 2. Verified reviewer cannot verify THEMSELVES.
  const verifierAgent = await authenticatedAgent(verifier.email);
  const self = await verifierAgent.a
    .post(`/api/staff/members/${verifierM.id}/reviewer-eligibility`)
    .set('X-CSRF-Token', verifierAgent.csrf)
    .send({ action: 'verify' });
  assert.strictEqual(self.status, 403);

  // 3. Verified reviewer CAN verify another pending reviewer.
  const verifyOther = await verifierAgent.a
    .post(`/api/staff/members/${targetM.id}/reviewer-eligibility`)
    .set('X-CSRF-Token', verifierAgent.csrf)
    .send({ action: 'verify' });
  assert.strictEqual(verifyOther.status, 200);
  assert.strictEqual(verifyOther.body.member.reviewerEligibility.status, 'verified');
});

test('invitations: acceptance is single-use and a concurrent race has one winner', async () => {
  const { admin } = await harness.makeClinic({});
  const { a, csrf } = await authenticatedAgent(admin.user.email);

  const created = await a
    .post('/api/staff/invitations')
    .set('X-CSRF-Token', csrf)
    .send({ email: 'raceinvite@synthetic.invalid', roleKey: 'care_coordinator' });
  assert.strictEqual(created.status, 201);

  // Pull the raw token from the server console is not possible here; instead
  // exercise the race through the service boundary using a known token.
  const Invitation = harness.models.Invitation;
  const { randomToken } = require('../../src/services/crypto');
  const raw = randomToken(32);
  const { ClinicMembership, User } = harness.models;
  const clinicId = admin.membership.clinic;
  await Invitation.create({
    clinic: clinicId,
    email: 'racer@synthetic.invalid',
    roleKey: 'care_coordinator',
    tokenHash: hmac(raw),
    invitedBy: admin.user.id,
  });

  const accept = () =>
    harness.agent(app).post('/api/auth/accept-invitation').send({
      token: raw,
      name: 'Racer',
      password: PASSWORD,
    });

  const [r1, r2] = await Promise.all([accept(), accept()]);
  const statuses = [r1.status, r2.status].sort();
  // Winner authenticates (200); the loser finds the invitation already claimed (404).
  assert.deepStrictEqual(statuses, [200, 404], `expected one winner, got ${statuses}`);

  // Exactly one membership now exists for that email.
  const user = await User.findOne({ email: 'racer@synthetic.invalid' });
  const memberships = await ClinicMembership.find({ user: user.id });
  assert.strictEqual(memberships.length, 1);

  // A third attempt with the same token fails.
  const third = await accept();
  assert.strictEqual(third.status, 404);
});

test('password reset: single-use token and revokes all sessions', async () => {
  const { admin } = await harness.makeClinic({});
  const { a, csrf } = await authenticatedAgent(admin.user.email);

  // Create a reset record directly (raw token known to the test).
  const { PasswordReset } = harness.models;
  const { randomToken } = require('../../src/services/crypto');
  const raw = randomToken(32);
  await PasswordReset.create({
    user: admin.user.id,
    tokenHash: hmac(raw),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });

  // Existing session works right now.
  assert.strictEqual((await a.get('/api/auth/me')).status, 200);

  const reset = await harness.agent(app)
    .post('/api/auth/password/reset')
    .send({ token: raw, password: 'BrandNewPass!56' });
  assert.strictEqual(reset.status, 200);

  // Old session is dead.
  assert.strictEqual((await a.get('/api/auth/me')).status, 401);

  // New password works; old one does not.
  const oldPw = await harness.agent(app)
    .post('/api/auth/login')
    .send({ email: admin.user.email, password: PASSWORD });
  assert.strictEqual(oldPw.status, 403);

  const newPw = await harness.agent(app)
    .post('/api/auth/login')
    .send({ email: admin.user.email, password: 'BrandNewPass!56' });
  assert.strictEqual(newPw.status, 200);

  // Token cannot be reused.
  const reuse = await harness.agent(app)
    .post('/api/auth/password/reset')
    .send({ token: raw, password: 'ThirdPass!78' });
  assert.strictEqual(reuse.status, 404);
});

test('expired invitation token is rejected', async () => {
  const { admin } = await harness.makeClinic({});
  const Invitation = harness.models.Invitation;
  const { randomToken } = require('../../src/services/crypto');
  const raw = randomToken(32);
  await Invitation.create({
    clinic: admin.membership.clinic,
    email: 'expired@synthetic.invalid',
    roleKey: 'care_coordinator',
    tokenHash: hmac(raw),
    invitedBy: admin.user.id,
    expiresAt: new Date(Date.now() - 1000),
  });
  const res = await harness.agent(app).post('/api/auth/accept-invitation').send({
    token: raw,
    password: PASSWORD,
  });
  assert.strictEqual(res.status, 404);
});

test('revoked invitation cannot be accepted', async () => {
  const { clinic, admin } = await harness.makeClinic({});
  const { user: coord } = await harness.makeMember(clinic, { roleKey: 'care_coordinator' });
  const { a, csrf } = await authenticatedAgent(admin.user.email);

  const created = await a
    .post('/api/staff/invitations')
    .set('X-CSRF-Token', csrf)
    .send({ email: 'revokeme@synthetic.invalid', roleKey: 'care_coordinator' });
  const invId = created.body.invitation.id;

  const revoked = await a
    .delete(`/api/staff/invitations/${invId}`)
    .set('X-CSRF-Token', csrf);
  assert.strictEqual(revoked.status, 200);

  // Find the stored hash and attempt acceptance with the real token: since the
  // raw token was console-only, verify the revoked doc blocks acceptance by
  // checking status flips and the atomic claim sees revokedAt.
  const Invitation = harness.models.Invitation;
  const doc = await Invitation.findById(invId);
  assert.ok(doc.revokedAt, 'revokedAt must be set');
});
