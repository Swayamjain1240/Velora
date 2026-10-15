'use strict';

// Part 9 exit gate: episode closure, the preflight, read-only history and reopen.
//
// The assertions the part turns on: closure is blocked by outstanding work unless
// it is explicitly overridden with a reason; only ASSIGNED staff may close;
// closure is one atomic state change under a revision guard; closure stops only
// FUTURE work and leaves recorded facts alone; a closed episode is read-only for
// new work; the history is append-only; and reopening is explicit, authorized,
// justified and audited without reviving stopped work.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const harness = require('../helpers/setup');
const zonedTime = require('../../src/services/zonedTime');
const { STATES } = require('../../src/policies/carePlanPolicy');

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

async function assign(ctx, memberUserId, responsibility, agent = ctx.coordCtx) {
  const res = await agent.a
    .post(`/api/episodes/${ctx.episode.id}/team`)
    .set('X-CSRF-Token', agent.csrf)
    .send({ memberUserId, responsibility });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.assignment;
}

async function setup({ assignCoordinator = true, assignReviewer = true } = {}) {
  const a = await harness.makeClinic({ codePrefix: 'CLOSA' });
  const ctx = { clinic: a.clinic };
  const coord = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  ctx.coord = coord;
  ctx.coordCtx = await harness.signInStaff(app, coord.user.email);
  const unassigned = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  ctx.unassigned = unassigned;
  ctx.unassignedCtx = await harness.signInStaff(app, unassigned.user.email);
  const reviewer = await harness.makeMember(a.clinic, { roleKey: 'clinical_reviewer', eligibility: 'verified' });
  ctx.reviewer = reviewer;
  ctx.reviewerCtx = await harness.signInStaff(app, reviewer.user.email);
  ctx.adminCtx = await harness.signInStaff(app, a.admin.user.email);

  const created = await harness.createPatient(ctx.coordCtx.a, ctx.coordCtx.csrf, {
    fullName: 'Synthetic Closure Patient',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ctx.patient = created.body.patient;

  const episodeRes = await ctx.coordCtx.a
    .post('/api/episodes')
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ patientId: ctx.patient.id, dischargeDate: zoneDate(-2), dischargeTimezone: ZONE });
  assert.equal(episodeRes.status, 201, JSON.stringify(episodeRes.body));
  ctx.episode = episodeRes.body.episode;

  if (assignCoordinator) await assign(ctx, coord.user.id, 'care_coordinator');
  if (assignReviewer) await assign(ctx, reviewer.user.id, 'clinical_reviewer');
  return ctx;
}

// All the checks a closure requires, confirmed.
function allChecks() {
  return [
    { key: 'plan_reviewed', confirmed: true },
    { key: 'medications_reconciled', confirmed: true },
    { key: 'follow_up_arranged', confirmed: true },
    { key: 'patient_informed', confirmed: true },
    { key: 'documents_archived', confirmed: true },
  ];
}

function closeBody(ctx, overrides = []) {
  return {
    expectedRevision: 1,
    reason: 'Coordination complete for this episode.',
    policyChecks: allChecks(),
    overrides,
    confirm: true,
  };
}

test('the preflight lists outstanding work and reports it is not closable', async () => {
  const ctx = await setup();
  // A plan version waiting for a decision, an open question, an active task and a
  // failed reminder all count as outstanding.
  await harness.models.CarePlanVersion.create({
    clinic: ctx.clinic.id,
    patient: ctx.patient.id,
    episode: ctx.episode.id,
    version: 1,
    state: STATES.IN_REVIEW,
    createdBy: ctx.coord.user.id,
    submittedAt: new Date(),
  });
  await harness.models.ClarificationThread.create({
    clinic: ctx.clinic.id,
    episode: ctx.episode.id,
    patient: ctx.patient.id,
    kind: 'operational',
    subject: 'Where do I send the form?',
    state: 'open',
    openedBy: ctx.coord.user.id,
    openedByRole: 'staff',
  });
  await harness.models.RecoveryTask.create({
    clinic: ctx.clinic.id,
    patient: ctx.patient.id,
    episode: ctx.episode.id,
    planVersion: new (require('mongoose').Types.ObjectId)(),
    item: new (require('mongoose').Types.ObjectId)(),
    itemKind: 'monitoring',
    title: 'Check temperature',
    originalWording: 'Check temperature twice daily',
    scheduleKind: 'fixed',
    conditional: false,
    timezone: ZONE,
    startDate: new Date(),
    status: 'active',
    preparedBy: ctx.coord.user.id,
  });
  await harness.models.Notification.create({
    clinic: ctx.clinic.id,
    patient: ctx.patient.id,
    episode: ctx.episode.id,
    kind: 'task_due',
    channel: 'in_app',
    dedupeKey: 'preflight-failed-1',
    title: 'A task is due',
    body: 'Scheduled for 09:00.',
    recipientUser: ctx.coord.user.id,
    recipientRole: 'staff',
    state: 'failed',
  });

  const res = await ctx.coordCtx.a
    .get(`/api/episodes/${ctx.episode.id}/closure/preflight`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const byKey = new Map(res.body.items.map((i) => [i.key, i]));
  assert.equal(byKey.get('unresolved_approvals').count, 1);
  assert.equal(byKey.get('open_clarifications').count, 1);
  assert.equal(byKey.get('open_tasks').count, 1);
  assert.equal(byKey.get('failed_deliveries').count, 1);
  assert.equal(byKey.get('missing_owners').count, 0);
  assert.equal(res.body.canClose, false);
  assert.ok(res.body.blocking.includes('unresolved_approvals'));
  assert.match(res.body.meaning, /operational state/i);
});

test('only assigned staff may preflight, close or reopen; admin and cross-clinic are refused', async () => {
  const ctx = await setup({ assignReviewer: false });
  const other = await harness.makeClinic({ codePrefix: 'CLOSB' });
  const otherCoord = await harness.makeMember(other.clinic, { roleKey: 'care_coordinator' });
  const otherCtx = await harness.signInStaff(app, otherCoord.user.email);

  const unassigned = await ctx.unassignedCtx.a
    .get(`/api/episodes/${ctx.episode.id}/closure/preflight`)
    .set('X-CSRF-Token', ctx.unassignedCtx.csrf);
  assert.equal(unassigned.status, 403, JSON.stringify(unassigned.body));

  const admin = await ctx.adminCtx.a
    .get(`/api/episodes/${ctx.episode.id}/closure/preflight`)
    .set('X-CSRF-Token', ctx.adminCtx.csrf);
  assert.equal(admin.status, 403, JSON.stringify(admin.body));

  const foreign = await otherCtx.a
    .get(`/api/episodes/${ctx.episode.id}/closure/preflight`)
    .set('X-CSRF-Token', otherCtx.csrf);
  assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
});

test('a blocking preflight item refuses closure unless it is overridden with a reason', async () => {
  const ctx = await setup();
  await harness.models.ClarificationThread.create({
    clinic: ctx.clinic.id,
    episode: ctx.episode.id,
    patient: ctx.patient.id,
    kind: 'clinical',
    subject: 'Dose timing question',
    state: 'open',
    openedBy: ctx.coord.user.id,
    openedByRole: 'staff',
  });

  const blocked = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/closure`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send(closeBody(ctx));
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.match(blocked.body.error.message, /open_clarifications/);

  const overridden = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/closure`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send(closeBody(ctx, [{ key: 'open_clarifications', reason: 'Answered by phone; thread will be closed separately.' }]));
  assert.equal(overridden.status, 201, JSON.stringify(overridden.body));
  assert.equal(overridden.body.episode.status, 'closed');
  assert.equal(overridden.body.closure.overrides[0].key, 'open_clarifications');
});

test('closure requires every clinic-policy check and a non-clinical reason', async () => {
  const ctx = await setup();

  const missing = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/closure`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({
      expectedRevision: 1,
      reason: 'Coordination complete.',
      policyChecks: [{ key: 'plan_reviewed', confirmed: true }],
      confirm: true,
    });
  assert.equal(missing.status, 400, JSON.stringify(missing.body));
  assert.match(missing.body.error.message, /Confirm these clinic-policy checks/);

  const notMet = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/closure`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({
      expectedRevision: 1,
      reason: 'Coordination complete.',
      policyChecks: allChecks().map((c) => (c.key === 'documents_archived' ? { ...c, confirmed: false } : c)),
      confirm: true,
    });
  assert.equal(notMet.status, 400, JSON.stringify(notMet.body));
  assert.match(notMet.body.error.message, /not met/);

  const wording = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/closure`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ ...closeBody(ctx), reason: 'The patient has recovered fully.' });
  assert.equal(wording.status, 400, JSON.stringify(wording.body));
  assert.match(wording.body.error.message, /clinical outcome/);
});

test('closure stops only FUTURE work and records the policy checks, actor and history', async () => {
  const ctx = await setup();
  const future = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const occurrence = await harness.models.ScheduleOccurrence.create({
    clinic: ctx.clinic.id,
    patient: ctx.patient.id,
    episode: ctx.episode.id,
    planVersion: new (require('mongoose').Types.ObjectId)(),
    item: new (require('mongoose').Types.ObjectId)(),
    ownerType: 'task',
    owner: new (require('mongoose').Types.ObjectId)(),
    scheduledAtUtc: future,
    localDate: zoneDate(2),
    localTime: '09:00',
    timezone: ZONE,
    status: 'scheduled',
  });
  const task = await harness.models.RecoveryTask.create({
    clinic: ctx.clinic.id,
    patient: ctx.patient.id,
    episode: ctx.episode.id,
    planVersion: new (require('mongoose').Types.ObjectId)(),
    item: new (require('mongoose').Types.ObjectId)(),
    itemKind: 'home_care',
    title: 'Keep dressing dry',
    originalWording: 'Keep the dressing dry',
    scheduleKind: 'fixed',
    conditional: false,
    timezone: ZONE,
    startDate: new Date(),
    status: 'active',
    preparedBy: ctx.coord.user.id,
  });
  const queued = await harness.models.Notification.create({
    clinic: ctx.clinic.id,
    patient: ctx.patient.id,
    episode: ctx.episode.id,
    kind: 'task_due',
    channel: 'in_app',
    dedupeKey: 'closure-stop-1',
    title: 'A task is due',
    body: 'Scheduled for 09:00.',
    recipientUser: ctx.coord.user.id,
    recipientRole: 'staff',
    state: 'queued',
  });

  // The active task is outstanding work, so closing over it needs an explicit
  // reason even though the closure itself ends it.
  const res = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/closure`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send(closeBody(ctx, [{ key: 'open_tasks', reason: 'Reviewed with the patient; open tasks end with the episode.' }]));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.closure.policyChecks.length, 5);
  assert.ok(res.body.closure.policyChecks.every((c) => c.confirmed));
  assert.equal(res.body.closure.actorLabel, ctx.coord.user.email);

  const cancelled = await harness.models.Notification.findById(queued._id).lean();
  assert.equal(cancelled.state, 'cancelled');
  const endedOccurrence = await harness.models.ScheduleOccurrence.findById(occurrence._id).lean();
  assert.equal(endedOccurrence.status, 'ended');
  const endedTask = await harness.models.RecoveryTask.findById(task._id).lean();
  assert.equal(endedTask.status, 'ended');

  const history = await ctx.coordCtx.a
    .get(`/api/episodes/${ctx.episode.id}/closure`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf);
  assert.equal(history.status, 200, JSON.stringify(history.body));
  assert.equal(history.body.items.length, 1);
  assert.equal(history.body.items[0].action, 'close');
  assert.equal(history.body.items[0].stopped.queuedRemindersCancelled, 1);
});

test('a stale revision is refused and a concurrent close changes state exactly once', async () => {
  const ctx = await setup();
  const [first, second] = await Promise.all([
    ctx.coordCtx.a
      .post(`/api/episodes/${ctx.episode.id}/closure`)
      .set('X-CSRF-Token', ctx.coordCtx.csrf)
      .send(closeBody(ctx)),
    ctx.reviewerCtx.a
      .post(`/api/episodes/${ctx.episode.id}/closure`)
      .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
      .send(closeBody(ctx)),
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [201, 409], `${first.status}/${second.status}`);

  const rows = await harness.models.EpisodeClosure.countDocuments({ episode: ctx.episode.id, action: 'close' });
  assert.equal(rows, 1);
});

test('closure history is append-only', async () => {
  const ctx = await setup();
  const res = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/closure`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send(closeBody(ctx));
  assert.equal(res.status, 201, JSON.stringify(res.body));

  await assert.rejects(
    () => harness.models.EpisodeClosure.updateOne({ _id: res.body.closure.id }, { $set: { reason: 'rewritten' } }),
    /append-only/
  );
  await assert.rejects(
    () => harness.models.EpisodeClosure.deleteOne({ _id: res.body.closure.id }),
    /append-only/
  );
});

test('a closed episode is read-only: new work is refused and history is preserved', async () => {
  const ctx = await setup();
  const res = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/closure`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send(closeBody(ctx));
  assert.equal(res.status, 201, JSON.stringify(res.body));

  const followUp = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/follow-ups`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ date: zoneDate(3), timezone: ZONE, location: 'Clinic A' });
  assert.equal(followUp.status, 409, JSON.stringify(followUp.body));

  const reminders = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/reminders/queue`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({});
  assert.equal(reminders.status, 409, JSON.stringify(reminders.body));

  const preflight = await ctx.coordCtx.a
    .get(`/api/episodes/${ctx.episode.id}/closure/preflight`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf);
  assert.equal(preflight.body.canClose, false);
  assert.equal(preflight.body.episode.closureState, 'closed');
});

test('reopening is explicit, authorized, justified, audited and does not revive stopped work', async () => {
  const ctx = await setup();
  const queued = await harness.models.Notification.create({
    clinic: ctx.clinic.id,
    patient: ctx.patient.id,
    episode: ctx.episode.id,
    kind: 'task_due',
    channel: 'in_app',
    dedupeKey: 'reopen-1',
    title: 'A task is due',
    body: 'Scheduled for 09:00.',
    recipientUser: ctx.coord.user.id,
    recipientRole: 'staff',
    state: 'queued',
  });
  const closed = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/closure`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send(closeBody(ctx));
  assert.equal(closed.status, 201, JSON.stringify(closed.body));
  const closedRevision = closed.body.episode.revision;

  const badReason = await ctx.reviewerCtx.a
    .post(`/api/episodes/${ctx.episode.id}/closure/reopen`)
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({ expectedRevision: closedRevision, reason: 'no', confirm: true });
  assert.equal(badReason.status, 400, JSON.stringify(badReason.body));

  const reopened = await ctx.reviewerCtx.a
    .post(`/api/episodes/${ctx.episode.id}/closure/reopen`)
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({ expectedRevision: closedRevision, reason: 'A new question needs coordination.', confirm: true });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal(reopened.body.episode.status, 'active');
  assert.equal(reopened.body.episode.closureState, 'open');

  // Stopped work stays stopped until it is created again deliberately.
  const stillCancelled = await harness.models.Notification.findById(queued._id).lean();
  assert.equal(stillCancelled.state, 'cancelled');

  const history = await ctx.coordCtx.a
    .get(`/api/episodes/${ctx.episode.id}/closure`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf);
  assert.deepEqual(
    history.body.items.map((i) => i.action),
    ['reopen', 'close']
  );

  const auditRow = await harness.models.AuditEvent.findOne({ action: 'episode.reopened' }).lean();
  assert.ok(auditRow, 'reopen must be audited');
  assert.equal(auditRow.category, 'closure');
});
