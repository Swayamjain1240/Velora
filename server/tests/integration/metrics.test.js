'use strict';

// Part 9 exit gate: operational metrics. The assertions the part turns on: the
// four metrics are computed from real workflow durations, every definition says
// what it is NOT a measure of, the response carries the no-clinical-inference
// note, queue age is scoped to the caller's own assignments, and the window is
// bounded.
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

const HOUR = 60 * 60 * 1000;
const ZONE = 'UTC';

async function setup() {
  const a = await harness.makeClinic({ codePrefix: 'META' });
  const ctx = { clinic: a.clinic };
  ctx.adminCtx = await harness.signInStaff(app, a.admin.user.email);
  const coord = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  ctx.coord = coord;
  ctx.coordCtx = await harness.signInStaff(app, coord.user.email);

  const created = await harness.createPatient(ctx.coordCtx.a, ctx.coordCtx.csrf, { fullName: 'Synthetic Metrics Patient' });
  ctx.patient = created.body.patient;
  const episodeRes = await ctx.coordCtx.a
    .post('/api/episodes')
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({
      patientId: ctx.patient.id,
      dischargeDate: zonedTime.addDays(zonedTime.todayInTimezone(ZONE), -1),
      dischargeTimezone: ZONE,
    });
  ctx.episode = episodeRes.body.episode;
  await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/team`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ memberUserId: coord.user.id, responsibility: 'care_coordinator' });

  const patientUser = await harness.makeMember(a.clinic, { roleKey: 'patient' });
  await harness.models.PatientProfile.updateOne(
    { _id: ctx.patient.id },
    { $set: { linkedUserId: patientUser.user.id, status: 'active' } }
  );
  ctx.patientCtx = await harness.signInStaff(app, patientUser.user.email);
  return ctx;
}

async function seedDurations(ctx) {
  const now = Date.now();
  await harness.models.CarePlanVersion.create([
    {
      clinic: ctx.clinic.id,
      patient: ctx.patient.id,
      episode: ctx.episode.id,
      version: 1,
      state: 'approved',
      createdBy: ctx.coord.user.id,
      submittedAt: new Date(now - 4 * HOUR),
      approvedAt: new Date(now - 2 * HOUR),
    },
    {
      clinic: ctx.clinic.id,
      patient: ctx.patient.id,
      episode: ctx.episode.id,
      version: 2,
      state: 'needs_clarification',
      createdBy: ctx.coord.user.id,
      submittedAt: new Date(now - 3 * HOUR),
      clarificationAt: new Date(now - 1 * HOUR),
    },
  ]);
  await harness.models.ClarificationThread.create({
    clinic: ctx.clinic.id,
    episode: ctx.episode.id,
    patient: ctx.patient.id,
    kind: 'operational',
    subject: 'Appointment question',
    state: 'answered',
    openedBy: ctx.coord.user.id,
    openedByRole: 'staff',
    answeredAt: new Date(now - 4 * HOUR),
    lastMessageAt: new Date(now - 4 * HOUR),
    createdAt: new Date(now - 5 * HOUR),
  });
}

test('metrics are computed from real workflow durations and never claim a clinical outcome', async () => {
  const ctx = await setup();
  await seedDurations(ctx);

  const res = await ctx.coordCtx.a.get('/api/metrics').set('X-CSRF-Token', ctx.coordCtx.csrf);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const byKey = new Map(res.body.metrics.map((m) => [m.key, m]));
  assert.ok(byKey.has('approval_time'));
  assert.ok(byKey.has('clarification_response_time'));
  assert.ok(byKey.has('queue_age'));
  assert.ok(byKey.has('coordination_workload'));

  // Two decisions: 2h (approved) and 2h (clarification), so the average is 2.
  assert.equal(byKey.get('approval_time').value.decisions, 2);
  assert.equal(byKey.get('approval_time').value.averageHours, 2);
  assert.equal(byKey.get('clarification_response_time').value.count, 1);
  assert.equal(byKey.get('clarification_response_time').value.averageHours, 1);

  assert.match(res.body.note, /not clinical outcomes/i);
  for (const metric of res.body.metrics) {
    assert.ok(metric.notAMeasureOf, `${metric.key} must state what it is not a measure of`);
  }
});

test('queue age is scoped to the caller and an empty scope reports no age', async () => {
  const ctx = await setup();
  const res = await ctx.coordCtx.a.get('/api/metrics').set('X-CSRF-Token', ctx.coordCtx.csrf);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const age = res.body.metrics.find((m) => m.key === 'queue_age');
  assert.ok(age.value.queues.pending_approvals);
  assert.equal(age.value.queues.pending_approvals.oldestHours, null);
  assert.match(res.body.clinicianNote, /own active assignments/i);
});

test('the metrics window is bounded and metrics are permission-gated', async () => {
  const ctx = await setup();
  const tooWide = await ctx.coordCtx.a
    .get('/api/metrics?from=2000-01-01T00:00:00.000Z')
    .set('X-CSRF-Token', ctx.coordCtx.csrf);
  assert.equal(tooWide.status, 400, JSON.stringify(tooWide.body));

  const patient = await ctx.patientCtx.a.get('/api/metrics').set('X-CSRF-Token', ctx.patientCtx.csrf);
  assert.equal(patient.status, 403, JSON.stringify(patient.body));

  const admin = await ctx.adminCtx.a.get('/api/metrics').set('X-CSRF-Token', ctx.adminCtx.csrf);
  assert.equal(admin.status, 200, JSON.stringify(admin.body));
});

// D-6: process health is exposed beside the workflow metrics so an operator can
// see saturation coming instead of sampling RSS from the OS.
test('runtime gauges are bounded, permission-scoped and never echo identifiers', async () => {
  const ctx = await setup();
  const patientId = ctx.patient.id;

  // Touch a parameterised route so the latency table has a pattern to record.
  const read = await ctx.coordCtx.a.get(`/api/patients/${patientId}`);
  assert.equal(read.status, 200, JSON.stringify(read.body));

  const res = await ctx.coordCtx.a.get('/api/metrics');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const runtime = res.body.runtime;
  assert.ok(runtime, 'runtime must be present');

  assert.equal(typeof runtime.process.uptimeSeconds, 'number');
  assert.ok(runtime.process.rssBytes > 0);
  assert.ok(runtime.process.heapUsedBytes > 0);
  assert.match(runtime.process.nodeVersion, /^v\d+/);

  assert.ok(runtime.eventLoop.meanMs >= 0);
  assert.ok(runtime.eventLoop.p95Ms >= runtime.eventLoop.meanMs - 1);
  assert.deepEqual(runtime.mongo.state, 'connected');
  assert.ok(Array.isArray(runtime.latency.routes));

  const patientRoute = runtime.latency.routes.find((r) => r.label === 'GET /api/patients/:patientId');
  assert.ok(patientRoute, `expected a pattern label, got ${runtime.latency.routes.map((r) => r.label).join(', ')}`);
  assert.ok(patientRoute.count >= 1);
  // The concrete identifier must never appear in an operational surface.
  assert.ok(!JSON.stringify(runtime).includes(patientId));

  // The workflow contract is unchanged by the addition.
  assert.ok(Array.isArray(res.body.metrics));
  assert.match(res.body.note, /not clinical outcomes/i);

  // Runtime gauges are as gated as the metrics they sit beside.
  const patient = await ctx.patientCtx.a.get('/api/metrics');
  assert.equal(patient.status, 403);
});
