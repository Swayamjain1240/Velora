'use strict';

// Part 8 exit gate: in-app reminders.
//
// The assertions the part turns on: a reminder is de-duplicated by recipient +
// event version + channel, every reminder is RECHECKED immediately before
// delivery (episode state, approved version, task relevance, recipient
// authorization), a stopped reminder is visibly skipped rather than silently
// dropped, retries are bounded and a failure stays visible, and a DELIVERED
// reminder is not an acknowledgement.
//
// The delivery provider is the disclosed development provider opencode: the shipped
// default is `in_app`, and both write the same attempt records.
process.env.REMINDER_PROVIDER = 'fake';

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

async function setup({ withCaregiver = false } = {}) {
  const a = await harness.makeClinic({ codePrefix: 'REMA' });
  const b = await harness.makeClinic({ codePrefix: 'REMB' });
  const ctx = { clinic: a.clinic, otherClinic: b.clinic };

  const coord = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  ctx.coord = coord;
  ctx.coordCtx = await harness.signInStaff(app, coord.user.email);
  const coord2 = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  ctx.coord2Ctx = await harness.signInStaff(app, coord2.user.email);
  const reviewer = await harness.makeMember(a.clinic, {
    roleKey: 'clinical_reviewer',
    eligibility: 'verified',
  });
  ctx.reviewerCtx = await harness.signInStaff(app, reviewer.user.email);
  ctx.adminCtx = await harness.signInStaff(app, a.admin.user.email);
  const otherCoord = await harness.makeMember(b.clinic, { roleKey: 'care_coordinator' });
  ctx.otherClinicCtx = await harness.signInStaff(app, otherCoord.user.email);

  const created = await harness.createPatient(ctx.coordCtx.a, ctx.coordCtx.csrf, {
    fullName: 'Synthetic Reminder Patient',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ctx.patient = created.body.patient;

  const episodeRes = await ctx.coordCtx.a
    .post('/api/episodes')
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    // Discharged two days ago, so the template's first (and only) slot is a
    // check-in that fell DUE at 09:00 yesterday in the episode timezone. A due
    // moment derived from a discharge date of "yesterday" would be in the future
    // until 09:00, which is what made this suite pass only after 09:00.
    .send({ patientId: ctx.patient.id, dischargeDate: zoneDate(-2), dischargeTimezone: ZONE });
  assert.equal(episodeRes.status, 201, JSON.stringify(episodeRes.body));
  ctx.episode = episodeRes.body.episode;

  const patientUser = await harness.makeMember(a.clinic, { roleKey: 'patient' });
  await harness.models.PatientProfile.updateOne(
    { _id: ctx.patient.id },
    { $set: { linkedUserId: patientUser.user.id, status: 'active' } }
  );
  ctx.patientUser = patientUser;
  ctx.patientCtx = await harness.signInStaff(app, patientUser.user.email);

  if (withCaregiver) {
    const email = `caregiver-${Date.now()}@synthetic.invalid`;
    const invited = await ctx.coordCtx.a
      .post(`/api/patients/${ctx.patient.id}/caregivers`)
      .set('X-CSRF-Token', ctx.coordCtx.csrf)
      .send({ email, scopes: ['view_profile', 'view_checkins', 'view_tasks'] });
    assert.equal(invited.status, 201, JSON.stringify(invited.body));
    const accepted = await harness.agent(app).post('/api/access/caregiver-invitation').send({
      token: invited.body.invitation.token,
      password: 'SyntheticCarePass!24',
      name: 'Synthetic Caregiver',
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    ctx.caregiverCtx = await harness.signInStaff(app, email, 'SyntheticCarePass!24');
    ctx.grantId = accepted.body.grant.id;
  }
  return ctx;
}

// A clinic check-in template with exactly ONE slot that is due and open at any
// minute of the day, which is what makes the exact queue counts in these tests
// stable around the clock. The episode is discharged two days ago, so the
// cadence (day+1 and day+2) puts both slots' 09:00 due time in the past; the
// 24-hour response window then closes yesterday's slot at the very moment
// today's opens. The due set is therefore always exactly one slot - never zero
// (what a fixture anchored to the clock produced before 09:00) and never two
// (what a 48-hour window produced after 09:00, which doubled every count here).
async function dueCheckIn(ctx) {
  const template = {
    key: 'post-op-wound',
    title: 'Post-operative wound check',
    questions: [
      { id: 'pain_level', prompt: 'How would you rate your pain today?', kind: 'scale', scaleMin: 0, scaleMax: 10 },
    ],
    cadence: { startOffsetDays: 1, everyDays: 1, horizonDays: 1 },
    responseWindowHours: 24,
    reviewRules: [],
  };
  const created = await ctx.coordCtx.a
    .post('/api/check-in-templates')
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send(template);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const activated = await ctx.reviewerCtx.a
    .post(`/api/check-in-templates/${created.body.template.id}/activate`)
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({ expectedRevision: 1 });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  const materialised = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/check-ins/materialise`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({});
  assert.equal(materialised.status, 201, JSON.stringify(materialised.body));
  const due = await ctx.coordCtx.a.get(
    `/api/episodes/${ctx.episode.id}/check-ins?view=due&page=1&limit=10`
  );
  assert.equal(due.status, 200, JSON.stringify(due.body));
  assert.ok(due.body.items.length >= 1, 'a due slot exists');
  return { templateId: created.body.template.id, slot: due.body.items[0] };
}

function remindersPath(ctx, suffix = '') {
  return `/api/episodes/${ctx.episode.id}/reminders${suffix}`;
}

async function queue(ctx, body = {}, agent = ctx.coordCtx) {
  return agent.a
    .post(remindersPath(ctx, '/queue'))
    .set('X-CSRF-Token', agent.csrf)
    .send(body);
}

async function deliver(ctx, body = {}, agent = ctx.coordCtx) {
  return agent.a
    .post(remindersPath(ctx, '/deliver'))
    .set('X-CSRF-Token', agent.csrf)
    .send(body);
}

test('queueing derives reminders from due work and never queues the same one twice', async () => {
  const ctx = await setup({ withCaregiver: true });
  await dueCheckIn(ctx);

  const first = await queue(ctx);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  // One reminder per recipient: the patient account and the caregiver grant.
  assert.equal(first.body.summary.queued, 2);
  assert.equal(first.body.summary.duplicates, 0);

  const second = await queue(ctx);
  assert.equal(second.status, 201);
  assert.equal(second.body.summary.queued, 0, 'the same recipient + version + channel is not queued again');
  assert.equal(second.body.summary.duplicates, 2);
  assert.equal(await harness.models.Notification.countDocuments({}), 2);

  const stored = await harness.models.Notification.find({}).lean();
  const byRole = Object.fromEntries(stored.map((n) => [n.recipientRole, n]));
  assert.equal(byRole.patient.recipientUser.toString(), ctx.patientUser.user.id);
  assert.equal(byRole.caregiver.recipientGrant.toString(), ctx.grantId);
  // The reminder states an operational fact and links to the questions; it never
  // summarises or interprets anything.
  assert.match(byRole.patient.body, /check-in is due/i);
  assert.ok(!/abnormal|diagnos|normal result/i.test(JSON.stringify(byRole.patient)));
});

test('delivery records an attempt, and delivery is not acknowledgement', async () => {
  const ctx = await setup();
  await dueCheckIn(ctx);
  await queue(ctx);

  const delivered = await deliver(ctx);
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
  assert.equal(delivered.body.summary.checked, 1);
  assert.equal(delivered.body.summary.delivered, 1);
  assert.equal(delivered.body.summary.failed, 0);

  const notification = await harness.models.Notification.findOne({}).lean();
  assert.equal(notification.state, 'delivered');
  assert.ok(!notification.acknowledgedAt, 'delivery never acknowledges');
  assert.ok(!notification.acknowledgedBy);
  assert.match(notification.acknowledgementNote, /has not been read or acknowledged/i);

  const attempts = await harness.models.DeliveryAttempt.find({}).lean();
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].outcome, 'delivered');
  assert.deepEqual(attempts[0].checks, {
    episodeOpen: true,
    versionCurrent: true,
    taskRelevant: true,
    recipientAuthorized: true,
  });
  assert.ok(attempts[0].durationMs >= 0);
  assert.equal(attempts[0].renderedBody, notification.body);

  // The recipient sees it in their own inbox and acknowledges it explicitly.
  const inbox = await ctx.patientCtx.a.get('/api/patient/me/reminders?page=1&limit=10');
  assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
  assert.equal(inbox.body.total, 1);
  assert.equal(inbox.body.items[0].acknowledgedAt, null);

  const ack = await ctx.patientCtx.a
    .post(`/api/patient/me/reminders/${notification._id}/acknowledge`)
    .set('X-CSRF-Token', ctx.patientCtx.csrf)
    .send({});
  assert.equal(ack.status, 200, JSON.stringify(ack.body));
  assert.ok(ack.body.notification.acknowledgedAt);
  assert.equal(ack.body.alreadyAcknowledged, false);

  const again = await ctx.patientCtx.a
    .post(`/api/patient/me/reminders/${notification._id}/acknowledge`)
    .set('X-CSRF-Token', ctx.patientCtx.csrf)
    .send({});
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyAcknowledged, true);

  // The team reads the same record with its attempt history.
  const team = await ctx.coordCtx.a.get(remindersPath(ctx, `/${notification._id}`));
  assert.equal(team.status, 200, JSON.stringify(team.body));
  assert.equal(team.body.notification.acknowledgedAt !== null, true);
  assert.equal(team.body.attempts.length, 1);
});

test('a recipient whose authorization was withdrawn stops the reminder visibly', async () => {
  const ctx = await setup({ withCaregiver: true });
  await dueCheckIn(ctx);
  await queue(ctx);
  assert.equal(await harness.models.Notification.countDocuments({}), 2);

  // The caregiver grant is revoked AFTER the reminder was queued.
  await harness.models.CaregiverGrant.updateOne(
    { _id: ctx.grantId },
    { $set: { status: 'revoked', revokedAt: new Date() } }
  );

  const delivered = await deliver(ctx);
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
  assert.equal(delivered.body.summary.delivered, 1, 'the patient is still delivered to');
  assert.equal(delivered.body.summary.skipped, 1, 'the revoked recipient is skipped');

  const caregiver = await harness.models.Notification.findOne({ recipientRole: 'caregiver' }).lean();
  assert.equal(caregiver.state, 'cancelled');
  assert.match(caregiver.cancelledReason, /check before delivery/i);
  assert.match(caregiver.lastError, /no longer authorized/i);

  const attempt = await harness.models.DeliveryAttempt.findOne({
    notification: caregiver._id,
  }).lean();
  assert.equal(attempt.outcome, 'skipped');
  assert.equal(attempt.checks.recipientAuthorized, false);
  assert.equal(attempt.checks.episodeOpen, true);
});

test('a task that is no longer active and a plan version that is no longer current both stop delivery', async () => {
  const ctx = await setup();
  const planVersion = await harness.models.CarePlanVersion.create({
    clinic: ctx.clinic._id,
    patient: ctx.patient.id,
    episode: ctx.episode.id,
    version: 1,
    state: 'approved',
    isCurrent: true,
    createdBy: ctx.coord.user.id,
  });
  const occurrence = await harness.models.ScheduleOccurrence.create({
    clinic: ctx.clinic._id,
    patient: ctx.patient.id,
    episode: ctx.episode.id,
    planVersion: planVersion._id,
    // A fixture occurrence: the plan item id only has to be a stable reference
    // for the relevance check this test exercises.
    item: planVersion._id,
    ownerType: 'task',
    owner: planVersion._id,
    origin: 'scheduled',
    scheduledAtUtc: new Date(Date.now() - 60 * 1000),
    localDate: zoneDate(0),
    localTime: '09:00',
    timezone: ZONE,
    status: 'scheduled',
  });

  const notification = await harness.models.Notification.create({
    clinic: ctx.clinic._id,
    patient: ctx.patient.id,
    episode: ctx.episode.id,
    kind: 'task_due',
    channel: 'in_app',
    dedupeKey: 'test:occurrence:1',
    title: 'Keep the dressing dry',
    body: 'Scheduled for 09:00.',
    recipientUser: ctx.patientUser.user.id,
    recipientRole: 'patient',
    sourceType: 'occurrence',
    source: occurrence._id,
    planVersion: planVersion._id,
    localDate: zoneDate(0),
    localTime: '09:00',
    timezone: ZONE,
    state: 'queued',
    nextAttemptAt: new Date(Date.now() - 1000),
  });

  // The occurrence is superseded before delivery: nothing is sent.
  await harness.models.ScheduleOccurrence.updateOne(
    { _id: occurrence._id },
    { $set: { status: 'superseded' } }
  );
  const first = await deliver(ctx);
  assert.equal(first.body.summary.skipped, 1, JSON.stringify(first.body));
  const skipped = await harness.models.DeliveryAttempt.findOne({}).lean();
  assert.equal(skipped.checks.taskRelevant, false);
  assert.match(skipped.reason, /no longer active/i);

  // A fresh reminder whose plan version is no longer current is stopped too.
  await harness.models.ScheduleOccurrence.updateOne(
    { _id: occurrence._id },
    { $set: { status: 'scheduled' } }
  );
  await harness.models.CarePlanVersion.updateOne(
    { _id: planVersion._id },
    { $set: { isCurrent: false, state: 'superseded' } }
  );
  await harness.models.Notification.updateOne(
    { _id: notification._id },
    {
      $set: {
        state: 'queued',
        cancelledAt: null,
        cancelledReason: null,
        lastError: null,
        nextAttemptAt: new Date(Date.now() - 1000),
      },
    }
  );
  const second = await deliver(ctx);
  assert.equal(second.body.summary.skipped, 1, JSON.stringify(second.body));
  const secondAttempt = await harness.models.DeliveryAttempt.findOne({
    notification: notification._id,
  })
    .sort({ attempt: -1 })
    .lean();
  assert.equal(secondAttempt.checks.versionCurrent, false);
  assert.match(secondAttempt.reason, /no longer current/i);
  assert.equal(
    await harness.models.DeliveryAttempt.countDocuments({ notification: notification._id }),
    2,
    'a repeated refusal records a new attempt rather than colliding with the old one'
  );
});

test('retries are bounded, and the failure stays visible instead of retrying forever', async () => {
  const ctx = await setup();
  const notification = await harness.models.Notification.create({
    clinic: ctx.clinic._id,
    patient: ctx.patient.id,
    episode: ctx.episode.id,
    kind: 'system',
    channel: 'in_app',
    dedupeKey: 'test:retry:1',
    // The development provider fails a title containing [fail], which is how the
    // failure and retry paths are exercised without a third party.
    title: '[fail] A reminder that cannot be delivered',
    body: 'Operational reminder.',
    recipientUser: ctx.patientUser.user.id,
    recipientRole: 'patient',
    sourceType: 'episode',
    state: 'queued',
    maxAttempts: 3,
    attempts: 0,
    nextAttemptAt: new Date(Date.now() - 1000),
  });

  const first = await deliver(ctx);
  assert.equal(first.body.summary.failed, 0);
  assert.equal(first.body.summary.retrying, 1, JSON.stringify(first.body));
  let stored = await harness.models.Notification.findById(notification._id).lean();
  assert.equal(stored.state, 'queued');
  assert.equal(stored.attempts, 1);
  assert.ok(stored.nextAttemptAt > new Date(), 'a retry is scheduled, not immediate');

  // A retry that is not yet due is not attempted.
  const notDue = await deliver(ctx);
  assert.equal(notDue.body.summary.checked, 0);

  await harness.models.Notification.updateOne(
    { _id: notification._id },
    { $set: { nextAttemptAt: new Date(Date.now() - 1000) } }
  );
  const second = await deliver(ctx);
  assert.equal(second.body.summary.retrying, 1);

  await harness.models.Notification.updateOne(
    { _id: notification._id },
    { $set: { nextAttemptAt: new Date(Date.now() - 1000) } }
  );
  const third = await deliver(ctx);
  assert.equal(third.body.summary.failed, 1, JSON.stringify(third.body));
  stored = await harness.models.Notification.findById(notification._id).lean();
  assert.equal(stored.state, 'failed');
  assert.equal(stored.attempts, 3);
  assert.equal(stored.nextAttemptAt, null);
  assert.ok(stored.failedAt);
  assert.equal(await harness.models.DeliveryAttempt.countDocuments({}), 3);

  // The failure is visible to the team, with the attempt chain and a note saying
  // what kind of problem it is.
  const listed = await ctx.coordCtx.a.get(remindersPath(ctx));
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const row = listed.body.items.find((item) => item.id === String(notification._id));
  assert.equal(row.state, 'failed');
  assert.match(row.failureNote, /delivery problem, not a missed dose/i);

  const detail = await ctx.coordCtx.a.get(remindersPath(ctx, `/${notification._id}`));
  assert.equal(detail.body.attempts.length, 3);
  assert.deepEqual(detail.body.attempts.map((a) => a.attempt), [1, 2, 3]);

  // The attempt budget is spent, so a retry is refused rather than looping.
  const retry = await ctx.coordCtx.a
    .post(remindersPath(ctx, `/${notification._id}/retry`))
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({});
  assert.equal(retry.status, 409, JSON.stringify(retry.body));
  assert.match(retry.body.error.message, /attempt budget|whole attempt budget/i);

  // Delivery attempts are append-only.
  const attempt = await harness.models.DeliveryAttempt.findOne({});
  attempt.set({ outcome: 'delivered' });
  await assert.rejects(() => attempt.save(), /append-only/i);
});

test('a closed episode queues nothing new and stops a queued reminder', async () => {
  const ctx = await setup();
  await dueCheckIn(ctx);
  await queue(ctx);
  const notification = await harness.models.Notification.findOne({}).lean();

  await harness.models.RecoveryEpisode.updateOne(
    { _id: ctx.episode.id },
    { $set: { status: 'closed' } }
  );

  const blocked = await queue(ctx);
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.match(blocked.body.error.message, /closed/i);

  const delivered = await deliver(ctx);
  assert.equal(delivered.body.summary.skipped, 1, JSON.stringify(delivered.body));
  const attempt = await harness.models.DeliveryAttempt.findOne({
    notification: notification._id,
  }).lean();
  assert.equal(attempt.checks.episodeOpen, false);
  // History stays readable after the episode closes.
  const listed = await ctx.coordCtx.a.get(remindersPath(ctx));
  assert.equal(listed.status, 200);
  assert.equal(listed.body.items.length, 1);
});

test('admins, unassigned staff and other clinics cannot reach the reminder queue', async () => {
  const ctx = await setup();
  await dueCheckIn(ctx);
  await queue(ctx);

  assert.equal((await ctx.adminCtx.a.get(remindersPath(ctx))).status, 403);
  assert.equal((await queue(ctx, {}, ctx.adminCtx)).status, 403);
  assert.equal((await deliver(ctx, {}, ctx.adminCtx)).status, 403);
  assert.equal((await ctx.coord2Ctx.a.get(remindersPath(ctx))).status, 403);
  assert.equal((await queue(ctx, {}, ctx.coord2Ctx)).status, 403);
  assert.equal((await ctx.otherClinicCtx.a.get(remindersPath(ctx))).status, 404);

  // A patient has no access to the team surface at all.
  assert.equal((await ctx.patientCtx.a.get(remindersPath(ctx))).status, 403);

  // Unknown fields and an out-of-range batch size are refused before any work.
  assert.equal((await queue(ctx, { kinds: ['clinical_alert'] })).status, 400);
  assert.equal((await deliver(ctx, { limit: 5000 })).status, 400);
  assert.equal((await deliver(ctx, { episodeId: String(ctx.otherClinic._id) })).status, 400);
});

test('the provider status says what is configured and what still needs disclosure', async () => {
  const ctx = await setup();
  const status = await ctx.adminCtx.a.get('/api/clinic/reminder-provider');
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.equal(status.body.provider.configured, 'fake');
  assert.equal(status.body.provider.active, 'fake');
  assert.deepEqual(status.body.provider.pendingDisclosure, ['email', 'sms', 'whatsapp', 'push']);
  assert.match(status.body.provider.disclosure.dataSent, /nothing leaves the process/i);

  // It is configuration, not clinical content: an administrator may read it, but
  // a coordinator cannot (they hold no clinic.update permission).
  assert.equal((await ctx.coordCtx.a.get('/api/clinic/reminder-provider')).status, 403);
});
