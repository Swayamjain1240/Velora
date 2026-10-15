'use strict';

// Part 9 exit gate: the audit trail.
//
// The assertions the part turns on: sensitive actions are recorded with a
// category and a record scope; secrets, tokens and raw clinical text are redacted
// before the row is written; search is paginated and window-bounded; an
// administrator may read the administrative trail but a clinical caller may not;
// and one clinic cannot read another clinic's trail.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const harness = require('../helpers/setup');
const auditService = require('../../src/services/auditService');
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

async function setup() {
  const a = await harness.makeClinic({ codePrefix: 'AUDA' });
  const ctx = { clinic: a.clinic };
  ctx.adminCtx = await harness.signInStaff(app, a.admin.user.email);
  const coord = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  ctx.coord = coord;
  ctx.coordCtx = await harness.signInStaff(app, coord.user.email);
  const reviewer = await harness.makeMember(a.clinic, { roleKey: 'clinical_reviewer', eligibility: 'verified' });
  ctx.reviewer = reviewer;
  ctx.reviewerCtx = await harness.signInStaff(app, reviewer.user.email);

  const created = await harness.createPatient(ctx.coordCtx.a, ctx.coordCtx.csrf, { fullName: 'Synthetic Audit Patient' });
  ctx.patient = created.body.patient;
  const episodeRes = await ctx.coordCtx.a
    .post('/api/episodes')
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ patientId: ctx.patient.id, dischargeDate: zonedTime.addDays(zonedTime.todayInTimezone(ZONE), -1), dischargeTimezone: ZONE });
  ctx.episode = episodeRes.body.episode;

  const patientUser = await harness.makeMember(a.clinic, { roleKey: 'patient' });
  await harness.models.PatientProfile.updateOne({ _id: ctx.patient.id }, { $set: { linkedUserId: patientUser.user.id, status: 'active' } });
  ctx.patientCtx = await harness.signInStaff(app, patientUser.user.email);
  return ctx;
}

// Produce a closure and a privacy-request event to search for.
async function seedEvents(ctx) {
  await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/team`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ memberUserId: ctx.reviewer.user.id, responsibility: 'clinical_reviewer' });
  await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/team`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ memberUserId: ctx.coord.user.id, responsibility: 'care_coordinator' });
  await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/closure`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({
      expectedRevision: 1,
      reason: 'Coordination complete for this episode.',
      policyChecks: [
        { key: 'plan_reviewed', confirmed: true },
        { key: 'medications_reconciled', confirmed: true },
        { key: 'follow_up_arranged', confirmed: true },
        { key: 'patient_informed', confirmed: true },
        { key: 'documents_archived', confirmed: true },
      ],
      confirm: true,
    });
  await ctx.coordCtx.a
    .post('/api/privacy-requests')
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ kind: 'export', detail: 'Please send me a copy of the record.', patientId: ctx.patient.id });
}

test('sensitive actions are recorded with a category and are searchable and paginated', async () => {
  const ctx = await setup();
  await seedEvents(ctx);

  const res = await ctx.adminCtx.a.get('/api/audit?limit=1').set('X-CSRF-Token', ctx.adminCtx.csrf);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.items.length, 1);
  assert.ok(res.body.total >= 2);
  assert.match(res.body.note, /redacted/i);

  const closure = await ctx.adminCtx.a
    .get('/api/audit?category=closure')
    .set('X-CSRF-Token', ctx.adminCtx.csrf);
  assert.equal(closure.status, 200, JSON.stringify(closure.body));
  assert.ok(closure.body.items.length >= 1);
  assert.ok(closure.body.items.every((i) => i.category === 'closure'));
  assert.equal(closure.body.items[0].subjectType, 'recovery_episode');
});

test('the search window is bounded and rejects a bad range', async () => {
  const ctx = await setup();
  const tooWide = await ctx.adminCtx.a
    .get('/api/audit?from=2020-01-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z')
    .set('X-CSRF-Token', ctx.adminCtx.csrf);
  assert.equal(tooWide.status, 400, JSON.stringify(tooWide.body));

  const reversed = await ctx.adminCtx.a
    .get('/api/audit?from=2026-10-10T00:00:00.000Z&to=2026-10-01T00:00:00.000Z')
    .set('X-CSRF-Token', ctx.adminCtx.csrf);
  assert.equal(reversed.status, 400, JSON.stringify(reversed.body));
});

test('the trail is administrative: a clinical caller and a patient are refused', async () => {
  const ctx = await setup();
  await seedEvents(ctx);

  for (const agent of [ctx.coordCtx, ctx.reviewerCtx, ctx.patientCtx]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await agent.a.get('/api/audit').set('X-CSRF-Token', agent.csrf);
    assert.equal(res.status, 403, JSON.stringify(res.body));
  }
});

test('one clinic cannot read another clinic trail', async () => {
  const ctx = await setup();
  await seedEvents(ctx);
  const other = await harness.makeClinic({ codePrefix: 'AUDB' });
  const otherAdmin = await harness.signInStaff(app, other.admin.user.email);
  const res = await otherAdmin.a.get('/api/audit?category=closure').set('X-CSRF-Token', otherAdmin.csrf);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.items.length, 0);
});

test('redaction strips secrets, tokens and clinical text before the row is written', async () => {
  const ctx = await setup();
  await auditService.record({
    clinic: ctx.clinic.id,
    actorUser: ctx.coord.user.id,
    actorLabel: ctx.coord.user.email,
    action: 'audit.redaction.probe',
    category: 'admin',
    outcome: 'success',
    detail: {
      password: 'super-secret-value',
      sessionToken: 'abc123',
      apiKey: 'key-123',
      originalWording: 'Take 5 mg twice a day',
      nested: { csrfSecret: 'csrf-value', ok: 'kept' },
    },
  });

  const row = await harness.models.AuditEvent.findOne({ action: 'audit.redaction.probe' }).lean();
  assert.ok(row);
  const serialized = JSON.stringify(row.detail);
  assert.ok(!serialized.includes('super-secret-value'));
  assert.ok(!serialized.includes('abc123'));
  assert.ok(!serialized.includes('key-123'));
  assert.ok(!serialized.includes('Take 5 mg'));
  assert.ok(!serialized.includes('csrf-value'));
  assert.equal(row.detail.nested.ok, 'kept');
  assert.equal(row.detail.password, '[redacted]');
});

test('audit rows are append-only', async () => {
  const ctx = await setup();
  await auditService.record({
    clinic: ctx.clinic.id,
    action: 'audit.append.only',
    category: 'admin',
    outcome: 'success',
  });
  const row = await harness.models.AuditEvent.findOne({ action: 'audit.append.only' }).lean();
  await assert.rejects(() => harness.models.AuditEvent.updateOne({ _id: row._id }, { $set: { action: 'changed' } }), /append-only/);
  await assert.rejects(() => harness.models.AuditEvent.deleteOne({ _id: row._id }), /append-only/);
});
