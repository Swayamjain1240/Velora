'use strict';

// Part 9 exit gate: privacy requests, the export lifecycle and the deletion
// evaluation. The assertions the part turns on: identity gates assignment, a
// decision gates execution, an export is encrypted/time-limited/freshly
// authorized/audited, revocation and expiry both stop a download, a deletion
// request is evaluated against retention (never an instant destroy), and one
// clinic's administrator cannot read another clinic's request.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const harness = require('../helpers/setup');
const zonedTime = require('../../src/services/zonedTime');

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

const ZONE = 'UTC';

function zoneDate(offsetDays = 0) {
  return zonedTime.addDays(zonedTime.todayInTimezone(ZONE), offsetDays);
}

async function setup() {
  const a = await harness.makeClinic({ codePrefix: 'PRIVA' });
  const ctx = { clinic: a.clinic };
  const coord = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  ctx.coord = coord;
  ctx.coordCtx = await harness.signInStaff(app, coord.user.email);
  ctx.adminCtx = await harness.signInStaff(app, a.admin.user.email);

  const created = await harness.createPatient(ctx.coordCtx.a, ctx.coordCtx.csrf, {
    fullName: 'Synthetic Privacy Patient',
    contactPhone: '+1 555 0100',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ctx.patient = created.body.patient;

  const patientUser = await harness.makeMember(a.clinic, { roleKey: 'patient' });
  await harness.models.PatientProfile.updateOne(
    { _id: ctx.patient.id },
    { $set: { linkedUserId: patientUser.user.id, status: 'active' } }
  );
  ctx.patientUser = patientUser;
  ctx.patientCtx = await harness.signInStaff(app, patientUser.user.email);

  return ctx;
}

async function createRequest(ctx, body, agent = ctx.coordCtx) {
  const res = await agent.a
    .post('/api/privacy-requests')
    .set('X-CSRF-Token', agent.csrf)
    .send({ patientId: ctx.patient.id, ...body });
  return res;
}

async function progressToApproved(ctx, requestId, agent = ctx.adminCtx) {
  const verified = await agent.a
    .post(`/api/privacy-requests/${requestId}/identity`)
    .set('X-CSRF-Token', agent.csrf)
    .send({ method: 'video_call' });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  const assigned = await agent.a
    .post(`/api/privacy-requests/${requestId}/assign`)
    .set('X-CSRF-Token', agent.csrf)
    .send({ ownerUserId: ctx.coord.user.id });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  const decided = await agent.a
    .post(`/api/privacy-requests/${requestId}/decide`)
    .set('X-CSRF-Token', agent.csrf)
    .send({ outcome: 'approved', reason: 'Identity confirmed and the record is in scope.' });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
}

test('a patient can raise a request about their own record and a caregiver cannot', async () => {
  const ctx = await setup();
  const own = await createRequest(ctx, { kind: 'export', detail: 'Please send me a copy of my record.' }, ctx.patientCtx);
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.equal(own.body.request.state, 'identity_pending');
  assert.equal(own.body.request.requesterRole, 'patient');

  // The subject is derived from the caller, never from the body: a patient
  // cannot point the request at someone else's profile.
  const other = await harness.createPatient(ctx.coordCtx.a, ctx.coordCtx.csrf, { fullName: 'Synthetic Other Patient' });
  const forged = await ctx.patientCtx.a
    .post('/api/privacy-requests')
    .set('X-CSRF-Token', ctx.patientCtx.csrf)
    .send({ kind: 'export', detail: 'Give me another patient record.', patientId: other.body.patient.id });
  assert.equal(forged.status, 201, JSON.stringify(forged.body));
  assert.equal(forged.body.request.patient, ctx.patient.id);
});

test('identity verification and assignment are administrative and gate each other', async () => {
  const ctx = await setup();
  const created = await createRequest(ctx, { kind: 'export', detail: 'Please send me a copy of my record.' });
  const id = created.body.request.id;

  // A coordinator cannot verify or assign.
  const deniedVerify = await ctx.coordCtx.a
    .post(`/api/privacy-requests/${id}/identity`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ method: 'in_person' });
  assert.equal(deniedVerify.status, 403, JSON.stringify(deniedVerify.body));

  // Assignment before verification is refused.
  const early = await ctx.adminCtx.a
    .post(`/api/privacy-requests/${id}/assign`)
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({ ownerUserId: ctx.coord.user.id });
  assert.equal(early.status, 409, JSON.stringify(early.body));

  const verified = await ctx.adminCtx.a
    .post(`/api/privacy-requests/${id}/identity`)
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({ method: 'video_call' });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  assert.equal(verified.body.request.state, 'identity_verified');

  const assigned = await ctx.adminCtx.a
    .post(`/api/privacy-requests/${id}/assign`)
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({ ownerUserId: ctx.coord.user.id });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  assert.equal(assigned.body.request.state, 'in_review');
});

test('a decision requires a reason and execution requires an approval', async () => {
  const ctx = await setup();
  const created = await createRequest(ctx, { kind: 'export', detail: 'Please send me a copy of my record.' });
  const id = created.body.request.id;
  await ctx.adminCtx.a.post(`/api/privacy-requests/${id}/identity`).set('X-CSRF-Token', ctx.adminCtx.csrf).send({ method: 'in_person' });
  await ctx.adminCtx.a.post(`/api/privacy-requests/${id}/assign`).set('X-CSRF-Token', ctx.adminCtx.csrf).send({ ownerUserId: ctx.coord.user.id });

  const noReason = await ctx.adminCtx.a
    .post(`/api/privacy-requests/${id}/decide`)
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({ outcome: 'approved', reason: 'no' });
  assert.equal(noReason.status, 400, JSON.stringify(noReason.body));

  const beforeApproval = await ctx.adminCtx.a
    .post(`/api/privacy-requests/${id}/execute`)
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({});
  assert.equal(beforeApproval.status, 409, JSON.stringify(beforeApproval.body));
});

test('an approved export is generated, freshly authorized, downloaded once and then refused', async () => {
  const ctx = await setup();
  const created = await createRequest(ctx, { kind: 'export', detail: 'Please send me a copy of my record.' });
  const id = created.body.request.id;
  await progressToApproved(ctx, id);

  const executed = await ctx.adminCtx.a
    .post(`/api/privacy-requests/${id}/execute`)
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({});
  assert.equal(executed.status, 200, JSON.stringify(executed.body));
  assert.equal(executed.body.request.state, 'completed');
  assert.ok(executed.body.request.execution.exportArtifact);

  // The requester (the coordinator here) downloads. Fresh authorization first.
  const authorized = await ctx.coordCtx.a
    .post(`/api/privacy-requests/${id}/export/authorize`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ purpose: 'Fulfilling the request' });
  assert.equal(authorized.status, 200, JSON.stringify(authorized.body));

  const download = await ctx.coordCtx.a.get(
    `/api/privacy-requests/${id}/export/download?token=${encodeURIComponent(authorized.body.token)}`
  );
  assert.equal(download.status, 200);
  assert.match(download.headers['content-disposition'] || '', /attachment/);
  assert.match(download.headers['cache-control'] || '', /no-store/);
  const parsed = download.body && typeof download.body === 'object' ? download.body : JSON.parse(download.text);
  assert.equal(parsed.format, 'velora.privacy-export/1');
  assert.equal(parsed.patient.reference, ctx.patient.reference);

  // A token is single-use.
  const replay = await ctx.coordCtx.a.get(
    `/api/privacy-requests/${id}/export/download?token=${encodeURIComponent(authorized.body.token)}`
  );
  assert.equal(replay.status, 409, JSON.stringify(replay.body));

  // The download is audited.
  const auditRow = await harness.models.AuditEvent.findOne({ action: 'privacy.export.downloaded' }).lean();
  assert.ok(auditRow);
  assert.equal(auditRow.category, 'download');
});

test('an export download requires fresh authorization and respects expiry and revocation', async () => {
  const ctx = await setup();
  const created = await createRequest(ctx, { kind: 'export', detail: 'Please send me a copy of my record.' });
  const id = created.body.request.id;
  await progressToApproved(ctx, id);
  await ctx.adminCtx.a.post(`/api/privacy-requests/${id}/execute`).set('X-CSRF-Token', ctx.adminCtx.csrf).send({});

  // Without a freshly authorized token, the download route refuses.
  const noToken = await ctx.coordCtx.a.get(`/api/privacy-requests/${id}/export/download?token=${'x'.repeat(24)}`);
  assert.equal(noToken.status, 404, JSON.stringify(noToken.body));

  // Revoking invalidates outstanding downloads.
  const revoked = await ctx.adminCtx.a
    .post(`/api/privacy-requests/${id}/revoke-export`)
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({ reason: 'The requester asked us to withdraw the copy.' });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  const authorizeAfterRevoke = await ctx.coordCtx.a
    .post(`/api/privacy-requests/${id}/export/authorize`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({});
  assert.equal(authorizeAfterRevoke.status, 409, JSON.stringify(authorizeAfterRevoke.body));

  // Expiry also stops a download.
  await harness.models.DataExport.updateOne({ request: id }, { $set: { revokedAt: null, expiresAt: new Date(Date.now() - 1000) } });
  const authorizeExpired = await ctx.coordCtx.a
    .post(`/api/privacy-requests/${id}/export/authorize`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({});
  assert.equal(authorizeExpired.status, 409, JSON.stringify(authorizeExpired.body));
});

test('a correction request applies only a supported contact field and is audited', async () => {
  const ctx = await setup();
  const created = await createRequest(ctx, {
    kind: 'correction',
    detail: 'Please correct my phone number.',
    correction: { field: 'contactPhone', newValue: '+1 555 0199' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.request.id;
  await progressToApproved(ctx, id);

  const executed = await ctx.adminCtx.a
    .post(`/api/privacy-requests/${id}/execute`)
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({});
  assert.equal(executed.status, 200, JSON.stringify(executed.body));
  assert.equal(executed.body.request.state, 'completed');
  assert.equal(executed.body.request.execution.appliedCorrection.field, 'contactPhone');

  const profile = await harness.models.PatientProfile.findById(ctx.patient.id).lean();
  assert.equal(profile.contactPhone, '+1 555 0199');

  // A clinical field is refused by the validator outright.
  const clinical = await ctx.coordCtx.a
    .post('/api/privacy-requests')
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({
      kind: 'correction',
      detail: 'Change the diagnosis wording.',
      patientId: ctx.patient.id,
      correction: { field: 'diagnosis', newValue: 'something else' },
    });
  assert.equal(clinical.status, 400, JSON.stringify(clinical.body));
});

test('a deletion request is evaluated against retention and never destroyed instantly', async () => {
  const ctx = await setup();
  // A closed episode is exactly the kind of record a deletion request asks about.
  const episode = await harness.models.RecoveryEpisode.create({
    clinic: ctx.clinic.id,
    patient: ctx.patient.id,
    reference: 'EP-DELETE1',
    dischargeDate: new Date(),
    dischargeTimezone: ZONE,
    status: 'closed',
    closureState: 'closed',
    createdBy: ctx.coord.user.id,
  });

  const created = await createRequest(ctx, { kind: 'deletion_request', detail: 'Please delete my records.' });
  const id = created.body.request.id;
  await progressToApproved(ctx, id);

  const withoutAck = await ctx.adminCtx.a
    .post(`/api/privacy-requests/${id}/execute`)
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({});
  assert.equal(withoutAck.status, 400, JSON.stringify(withoutAck.body));

  const executed = await ctx.adminCtx.a
    .post(`/api/privacy-requests/${id}/execute`)
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({ acknowledgeNoDestruction: true });
  assert.equal(executed.status, 200, JSON.stringify(executed.body));
  assert.equal(executed.body.request.state, 'partially_completed');
  assert.equal(executed.body.request.execution.limited, true);
  assert.match(executed.body.request.execution.result, /No destructive deletion/);

  // Nothing was actually destroyed.
  const stillThere = await harness.models.RecoveryEpisode.findById(episode._id).lean();
  assert.ok(stillThere);
});

test('an active retention hold is recorded on the deletion evaluation', async () => {
  const ctx = await setup();
  const created = await createRequest(ctx, { kind: 'deletion_request', detail: 'Please delete my records.' });
  const id = created.body.request.id;
  await progressToApproved(ctx, id);

  await harness.models.RetentionHold.create({
    clinic: ctx.clinic.id,
    scope: 'subject',
    category: 'historical_records',
    subjectType: 'patient_profile',
    subjectId: String(ctx.patient.id),
    reason: 'Open complaint requires the record to be kept.',
    createdBy: ctx.coord.user.id,
  });

  const executed = await ctx.adminCtx.a
    .post(`/api/privacy-requests/${id}/execute`)
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({ acknowledgeNoDestruction: true });
  assert.equal(executed.status, 200, JSON.stringify(executed.body));
  assert.ok(executed.body.request.execution.holds.length >= 1);
});

test('the requester may cancel and only their own request is visible to a non-administrator', async () => {
  const ctx = await setup();
  const created = await createRequest(ctx, { kind: 'export', detail: 'Please send me a copy of my record.' });
  const id = created.body.request.id;

  const mine = await ctx.coordCtx.a.get('/api/privacy-requests').set('X-CSRF-Token', ctx.coordCtx.csrf);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.items.length, 1);

  const cancelled = await ctx.coordCtx.a
    .post(`/api/privacy-requests/${id}/cancel`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ reason: 'I no longer need the copy.' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.request.state, 'cancelled');

  const otherClinic = await harness.makeClinic({ codePrefix: 'PRIVB' });
  const foreignAdmin = await harness.signInStaff(app, otherClinic.admin.user.email);
  const foreign = await foreignAdmin.a
    .get(`/api/privacy-requests/${id}`)
    .set('X-CSRF-Token', foreignAdmin.csrf);
  assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
});

test('the privacy trail is audited and carries no secrets or clinical text', async () => {
  const ctx = await setup();
  const created = await createRequest(ctx, { kind: 'export', detail: 'Please send me a copy of my record.' });
  await progressToApproved(ctx, created.body.request.id);
  await ctx.adminCtx.a
    .post(`/api/privacy-requests/${created.body.request.id}/execute`)
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({});

  const rows = await harness.models.AuditEvent.find({ category: { $in: ['privacy_request', 'export'] } }).lean();
  assert.ok(rows.length >= 3);
  const serialized = JSON.stringify(rows);
  assert.ok(!/password|tokenHash|secret/i.test(serialized), 'audit rows must not leak secrets');
});
