'use strict';

// Part 2 integration tests: patient onboarding, consent and caregiver access.
// Runs against a replica-set MongoDB so the transactional invariants are real.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const harness = require('../helpers/setup');

let app;

test.before(async () => {
  app = await harness.init();
});

test.beforeEach(async () => {
  await harness.resetDb();
});

test.after(async () => {
  await harness.shutdown();
});

// Two clinics, each with its own staff, so isolation is tested for real.
async function twoClinics() {
  const a = await harness.makeClinic({ codePrefix: 'CLINICA' });
  const b = await harness.makeClinic({ codePrefix: 'CLINICB' });
  const ctx = {};
  ctx.clinicA = a.clinic;
  ctx.clinicB = b.clinic;
  ctx.adminA = a.admin;
  ctx.adminCtx = await harness.signInStaff(app, a.admin.user.email);

  const coordA = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  ctx.coordA = coordA;
  ctx.coordCtx = await harness.signInStaff(app, coordA.user.email);

  // A second coordinator in clinic A who will not be assigned anything.
  const coord2A = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  ctx.coord2Ctx = await harness.signInStaff(app, coord2A.user.email);

  const reviewerA = await harness.makeMember(a.clinic, { roleKey: 'clinical_reviewer' });
  ctx.reviewerCtx = await harness.signInStaff(app, reviewerA.user.email);

  const coordB = await harness.makeMember(b.clinic, { roleKey: 'care_coordinator' });
  ctx.otherClinicCtx = await harness.signInStaff(app, coordB.user.email);
  return ctx;
}

async function createPatientAs(ctx, body = {}) {
  const res = await harness.createPatient(ctx.coordCtx.a, ctx.coordCtx.csrf, {
    fullName: 'Synthetic Patient',
    ...body,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.patient;
}

// Creates, consents and activates a patient - the precondition for caregiver
// acceptance.
async function activePatient(ctx, body = {}) {
  const patient = await createPatientAs(ctx, body);
  const consent = await ctx.coordCtx.a
    .post(`/api/patients/${patient.id}/consent`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ action: 'granted', purpose: 'care coordination', categories: ['care_coordination'] });
  assert.equal(consent.status, 201, JSON.stringify(consent.body));
  const activated = await ctx.coordCtx.a
    .post(`/api/patients/${patient.id}/activate`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf);
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  return activated.body.patient;
}

test('a coordinator creates a patient and is recorded as the responsible assignee', async () => {
  const ctx = await twoClinics();
  const patient = await createPatientAs(ctx);
  assert.equal(patient.status, 'draft');
  assert.match(patient.reference, /^PT-[A-Z0-9]+$/);

  const assignments = await ctx.coordCtx.a.get(`/api/patients/${patient.id}/assignments`);
  assert.equal(assignments.status, 200);
  assert.equal(assignments.body.items.length, 1);
  assert.equal(assignments.body.items[0].status, 'active');
  assert.equal(assignments.body.items[0].memberEmail, ctx.coordA.user.email);
});


async function listPatientsFor(ctx, a) {
  const res = await a.get('/api/patients');
  return { status: res.status, body: res.body };
}
async function listPatientsFor(ctx, a) {
  const res = await a.get('/api/patients');
  return { status: res.status, body: res.body };
}test('an unassigned staff member of the SAME clinic gets a uniform 404', async () => {
  const ctx = await twoClinics();
  const patient = await createPatientAs(ctx);

  const detail = await ctx.coord2Ctx.a.get(`/api/patients/${patient.id}`);
  assert.equal(detail.status, 404);
  assert.equal(detail.body.error.code, 'NOT_FOUND');

  // ...and the patient is absent from their scoped list.
  const list = await listPatientsFor(ctx, ctx.coord2Ctx.a);
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 0);
});

test('another clinic can neither read the patient nor see it in any list', async () => {
  const ctx = await twoClinics();
  const patient = await createPatientAs(ctx);

  const detail = await ctx.otherClinicCtx.a.get(`/api/patients/${patient.id}`);
  assert.equal(detail.status, 404);

  const list = await ctx.otherClinicCtx.a.get('/api/patients');
  assert.equal(list.body.total, 0);
});

test('an admin cannot use admin status to read patient metadata (403)', async () => {
  const ctx = await twoClinics();
  const patient = await createPatientAs(ctx);

  const detail = await ctx.adminCtx.a.get(`/api/patients/${patient.id}`);
  assert.equal(detail.status, 403);
  assert.equal(detail.body.error.code, 'FORBIDDEN');
});

test('a duplicate clinic-scoped reference is rejected, but the same reference in another clinic is fine', async () => {
  const ctx = await twoClinics();
  await createPatientAs(ctx, { reference: 'PT-DUP01' });

  const dup = await harness.createPatient(ctx.coordCtx.a, ctx.coordCtx.csrf, {
    fullName: 'Another Person',
    reference: 'PT-DUP01',
  });
  assert.equal(dup.status, 409, JSON.stringify(dup.body));

  // A different clinic may reuse the reference: uniqueness is clinic-scoped.
  const other = await harness.createPatient(ctx.otherClinicCtx.a, ctx.otherClinicCtx.csrf, {
    fullName: 'Other Clinic Person',
    reference: 'PT-DUP01',
  });
  assert.equal(other.status, 201, JSON.stringify(other.body));
});

test('the last responsible assignee can never be removed', async () => {
  const ctx = await twoClinics();
  const patient = await createPatientAs(ctx);
  const assignments = await ctx.coordCtx.a.get(`/api/patients/${patient.id}/assignments`);
  const only = assignments.body.items[0];

  // The route only knows 'assignmentId' (assignmentParams). Use the identifier
  // the API exposes for the interval we just received.
  const revoked = await ctx.coordCtx.a
    .delete(`/api/patients/${patient.id}/assignments/${only.id}`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf);
  assert.equal(revoked.status, 409, JSON.stringify(revoked.body));
  assert.equal(revoked.body.error.code, 'CONFLICT');
});

test('reassignment keeps history and duplicate assignment is idempotent', async () => {
  const ctx = await twoClinics();
  const patient = await createPatientAs(ctx);
  const coordinatorUserId = (await ctx.coordCtx.a.get('/api/auth/me')).body.user.id;

  // Assigning the same person again must not create a second active interval.
  const again = await ctx.coordCtx.a
    .post(`/api/patients/${patient.id}/assignments`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ memberUserId: coordinatorUserId });
  assert.ok([200, 201].includes(again.status));

  let assignments = await ctx.coordCtx.a.get(`/api/patients/${patient.id}/assignments`);
  assert.equal(assignments.body.items.filter((i) => i.status === 'active').length, 1);

  // Add a second assignee, then remove the original: history is preserved.
  const reviewerUser = await ctx.coordCtx.a.get('/api/patients/assignees');
  const reviewer = reviewerUser.body.items.find((i) => i.roleKey === 'clinical_reviewer');
  const added = await ctx.coordCtx.a
    .post(`/api/patients/${patient.id}/assignments`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ memberUserId: reviewer.userId });
  assert.equal(added.status, 201, JSON.stringify(added.body));

  const original = assignments.body.items.find((i) => i.status === 'active');
  // The route only knows 'assignmentId'; the id from the list is the correct
  // identifier and keeps the update atomic against the same interval.
  const removed = await ctx.coordCtx.a
    .delete(`/api/patients/${patient.id}/assignments/${original.id}`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.assignment.status, 'revoked');

  // The coordinator revoked their OWN interval, so they correctly lose access.
  // The still-assigned reviewer is used to prove both intervals are retained.
  assignments = await ctx.reviewerCtx.a.get(`/api/patients/${patient.id}/assignments`);
  assert.equal(assignments.status, 200, JSON.stringify(assignments.body));
  assert.equal(assignments.body.items.length, 2, 'both intervals are retained');
  assert.equal(assignments.body.items.filter((i) => i.status === 'active').length, 1);
});

test('consent is append-only and its history is preserved', async () => {
  const ctx = await twoClinics();
  const patient = await createPatientAs(ctx);

  for (const categories of [['care_coordination'], ['care_coordination', 'caregiver_access']]) {
    const res = await ctx.coordCtx.a
      .post(`/api/patients/${patient.id}/consent`)
      .set('X-CSRF-Token', ctx.coordCtx.csrf)
      .send({ action: 'granted', purpose: 'care coordination', categories });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
  const withdrawn = await ctx.coordCtx.a
    .post(`/api/patients/${patient.id}/consent`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ action: 'withdrawn', purpose: 'care coordination' });
  assert.equal(withdrawn.status, 201);

  const history = await ctx.coordCtx.a.get(`/api/patients/${patient.id}/consent`);
  assert.equal(history.status, 200);
  assert.equal(history.body.total, 3, 'all three rows are retained');
  assert.equal(history.body.latest.action, 'withdrawn');
});

test('activation requires recorded consent and at least one assignee', async () => {
  const ctx = await twoClinics();
  const patient = await createPatientAs(ctx);

  // No consent yet -> refuse.
  const tooEarly = await ctx.coordCtx.a
    .post(`/api/patients/${patient.id}/activate`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf);
  assert.equal(tooEarly.status, 409);

  await ctx.coordCtx.a
    .post(`/api/patients/${patient.id}/consent`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ action: 'granted', purpose: 'care coordination', categories: ['care_coordination'] });

  const activated = await ctx.coordCtx.a
    .post(`/api/patients/${patient.id}/activate`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf);
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  assert.equal(activated.body.patient.status, 'active');
});

test('patient activation links the account and gives the patient their own view', async () => {
  const ctx = await twoClinics();
  const patient = await activePatient(ctx);

  const invited = await ctx.coordCtx.a
    .post(`/api/patients/${patient.id}/activation-invitation`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ email: 'patient.one@synthetic.invalid' });
  assert.equal(invited.status, 201, JSON.stringify(invited.body));
  const { token } = invited.body.invitation;

  const accepted = await harness.agent(app).post('/api/access/patient-activation').send({
    token,
    password: 'SyntheticPatientPass!24',
    name: 'Synthetic Patient',
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.patient.status, 'active');

  const patientCtx = await harness.signInStaff(app, 'patient.one@synthetic.invalid', 'SyntheticPatientPass!24');
  const own = await patientCtx.a.get('/api/patient/me/profile');
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.patient.id, patient.id);

  // The patient role must not reach clinic-wide staff data.
  const forbidden = await patientCtx.a.get('/api/staff/members');
  assert.equal(forbidden.status, 403);

  // Re-using the activation token is refused.
  const replay = await harness.agent(app).post('/api/access/patient-activation').send({
    token,
    password: 'SyntheticPatientPass!24',
  });
  assert.equal(replay.status, 400);
});

test('a caregiver grant is inactive until the invitation is accepted', async () => {
  const ctx = await twoClinics();
  const patient = await activePatient(ctx);

  const invited = await ctx.coordCtx.a
    .post(`/api/patients/${patient.id}/caregivers`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ email: 'caregiver.one@synthetic.invalid' });
  assert.equal(invited.status, 201, JSON.stringify(invited.body));
  assert.equal(invited.body.grant.status, 'pending');

  // Before acceptance there is no account bound to the grant at all.
  const pending = await harness.models.CaregiverGrant.findById(invited.body.grant.id).lean();
  assert.equal(pending.caregiverUser, null);
  assert.equal(pending.status, 'pending');
});

test('accepting a caregiver invitation activates exactly the scopes granted', async () => {
  const ctx = await twoClinics();
  const patient = await activePatient(ctx);

  const invited = await ctx.coordCtx.a
    .post(`/api/patients/${patient.id}/caregivers`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ email: 'caregiver.two@synthetic.invalid', scopes: ['view_profile'] });
  assert.equal(invited.status, 201, JSON.stringify(invited.body));

  const accepted = await harness.agent(app).post('/api/access/caregiver-invitation').send({
    token: invited.body.invitation.token,
    password: 'SyntheticCarePass!24',
    name: 'Synthetic Caregiver',
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.grant.status, 'active');
  assert.deepEqual(accepted.body.grant.scopes, ['view_profile']);

  const caregiverCtx = await harness.signInStaff(app, 'caregiver.two@synthetic.invalid', 'SyntheticCarePass!24');
  const shared = await caregiverCtx.a.get(`/api/caregiver/me/patients/${patient.id}`);
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  assert.equal(shared.body.patient.id, patient.id);

  const list = await caregiverCtx.a.get('/api/caregiver/me/patients');
  assert.equal(list.body.total, 1);

  // A caregiver holds no clinical approval or staff capability.
  assert.equal((await caregiverCtx.a.get('/api/staff/members')).status, 403);
});

test('a scope that was NOT granted denies access without revealing the record', async () => {
  const ctx = await twoClinics();
  const patient = await activePatient(ctx);

  // view_episodes only - deliberately no view_profile.
  const invited = await ctx.coordCtx.a
    .post(`/api/patients/${patient.id}/caregivers`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ email: 'caregiver.three@synthetic.invalid', scopes: ['view_episodes'] });
  assert.equal(invited.status, 201, JSON.stringify(invited.body));

  await harness.agent(app).post('/api/access/caregiver-invitation').send({
    token: invited.body.invitation.token,
    password: 'SyntheticCarePass!24',
  });

  const caregiverCtx = await harness.signInStaff(app, 'caregiver.three@synthetic.invalid', 'SyntheticCarePass!24');
  const denied = await caregiverCtx.a.get(`/api/caregiver/me/patients/${patient.id}`);
  assert.equal(denied.status, 404, 'no view_profile scope -> 404, not 403');
  assert.equal((await caregiverCtx.a.get('/api/caregiver/me/patients')).body.total, 0);
});

test('revoking a caregiver grant blocks the very next request', async () => {
  const ctx = await twoClinics();
  const patient = await activePatient(ctx);

  const invited = await ctx.coordCtx.a
    .post(`/api/patients/${patient.id}/caregivers`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ email: 'caregiver.four@synthetic.invalid' });
  await harness.agent(app).post('/api/access/caregiver-invitation').send({
    token: invited.body.invitation.token,
    password: 'SyntheticCarePass!24',
  });
  const caregiverCtx = await harness.signInStaff(app, 'caregiver.four@synthetic.invalid', 'SyntheticCarePass!24');
  assert.equal((await caregiverCtx.a.get(`/api/caregiver/me/patients/${patient.id}`)).status, 200);

  const revoked = await ctx.coordCtx.a
    .delete(`/api/patients/${patient.id}/caregivers/${invited.body.grant.id}`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.grant.status, 'revoked');

  const after = await caregiverCtx.a.get(`/api/caregiver/me/patients/${patient.id}`);
  assert.equal(after.status, 404, 'revocation takes effect immediately');
  assert.equal((await caregiverCtx.a.get('/api/caregiver/me/patients')).body.total, 0);
});

test('a caregiver invitation is single-use under a concurrent race, and expiry is enforced', async () => {
  const ctx = await twoClinics();
  const patient = await activePatient(ctx);

  const invited = await ctx.coordCtx.a
    .post(`/api/patients/${patient.id}/caregivers`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ email: 'caregiver.race@synthetic.invalid' });
  const token = invited.body.invitation.token;

  const [r1, r2] = await Promise.all([
    harness.agent(app).post('/api/access/caregiver-invitation').send({ token, password: 'SyntheticCarePass!24' }),
    harness.agent(app).post('/api/access/caregiver-invitation').send({ token, password: 'SyntheticCarePass!24' }),
  ]);
  const accepted = [r1, r2].filter((r) => r.status === 200);
  assert.equal(accepted.length, 1, `exactly one acceptance should win (got ${r1.status}/${r2.status})`);

  // Expired invitation is refused.
  const second = await ctx.coordCtx.a
    .post(`/api/patients/${patient.id}/caregivers`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ email: 'caregiver.expired@synthetic.invalid' });
  await harness.models.AccessInvitation.updateOne(
    { _id: second.body.invitation.id },
    { $set: { expiresAt: new Date(Date.now() - 60_000) } }
  );
  const expired = await harness.agent(app).post('/api/access/caregiver-invitation').send({
    token: second.body.invitation.token,
    password: 'SyntheticCarePass!24',
  });
  assert.equal(expired.status, 400);
});

test('pagination totals are scoped to the caller', async () => {
  const ctx = await twoClinics();
  for (let i = 0; i < 3; i += 1) {
    await createPatientAs(ctx, { fullName: `Synthetic Patient ${i}` });
  }
  // A staff user always carries a CSRF cookie. Grab a fresh one so the header
  // is never undefined/empty (which would be rejected with 400).
  const csrf = ctx.coordCtx.csrf;
  const page = await ctx.coordCtx.a.get('/api/patients?page=1&limit=2').set('X-CSRF-Token', csrf);
  assert.equal(page.status, 200);
  assert.equal(page.body.items.length, 2);
  assert.equal(page.body.total, 3, 'total reflects all assigned patients, not the page');
  assert.equal(page.body.limit, 2);
});

test('validation rejects unknown fields and never returns HTML', async () => {
  const ctx = await twoClinics();
  const unknown = await harness.createPatient(ctx.coordCtx.a, ctx.coordCtx.csrf, {
    fullName: 'Synthetic Patient',
    role: 'admin',
  });
  assert.equal(unknown.status, 400, 'unknown fields are rejected, not stripped');

  // A markup-looking name is stored as DATA. The server must never reflect it as
  // HTML: every response is a JSON envelope with a JSON content type, so the
  // browser cannot execute it (the client escapes on render).
  const xss = await harness.createPatient(ctx.coordCtx.a, ctx.coordCtx.csrf, {
    fullName: '<script>alert(1)</script>',
  });
  assert.equal(xss.status, 201);
  assert.match(xss.headers['content-type'], /application\/json/);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(xss.body)));
  assert.equal(xss.body.patient.fullName, '<script>alert(1)</script>');

  // A rejected request also stays JSON, never an HTML error page.
  const bad = await harness.createPatient(ctx.coordCtx.a, ctx.coordCtx.csrf, { role: 'admin' });
  assert.equal(bad.status, 400);
  assert.match(bad.headers['content-type'], /application\/json/);
});

test('an inactive clinic membership cannot read patients', async () => {
  const ctx = await twoClinics();
  await createPatientAs(ctx);

  const me = await ctx.coord2Ctx.a.get('/api/auth/me');
  const membership = await harness.models.ClinicMembership.findOne({
    user: me.body.user.id,
    status: 'active',
  });
  const coord2Email = me.body.user.email;
  assert.ok(membership, 'expected an active membership to deactivate');
  membership.status = 'inactive';
  await membership.save();

  // Re-sign-in through the real stack so a brand-new session + CSRF cookie is
  // used. A stale cookie left over from the active-membership login would keep
  // passing the membership/permission gates and mask the denial.
  const fresh = await harness.signInStaff(app, coord2Email, 'SyntheticTestPass!24');
  assert.equal(fresh.login.status, 200, JSON.stringify(fresh.login.body));
  const res = await fresh.a.get('/api/patients');
  assert.ok([401, 403].includes(res.status), `expected denial, got ${res.status}`);
});
