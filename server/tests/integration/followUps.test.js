'use strict';

// Part 8 exit gate: basic prescribed follow-ups.
//
// The assertions the part turns on: a follow-up carries ONLY a date, a location,
// a contact and an optional in-app reminder - a test-result, report-matching or
// referral request is refused rather than stored - the assigned care team
// prescribes it, the patient and an authorized caregiver may read it, and its
// in-app reminder appears when the clinic said it should.
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
  const a = await harness.makeClinic({ codePrefix: 'FLLA' });
  const b = await harness.makeClinic({ codePrefix: 'FLLB' });
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
    fullName: 'Synthetic Follow-up Patient',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ctx.patient = created.body.patient;

  const episodeRes = await ctx.coordCtx.a
    .post('/api/episodes')
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
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

  // A reviewer on the episode, so the team has both responsibilities.
  await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/team`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ memberUserId: reviewer.user.id, responsibility: 'clinical_reviewer' });

  if (withCaregiver) {
    const email = `caregiver-${Date.now()}@synthetic.invalid`;
    const invited = await ctx.coordCtx.a
      .post(`/api/patients/${ctx.patient.id}/caregivers`)
      .set('X-CSRF-Token', ctx.coordCtx.csrf)
      .send({ email, scopes: ['view_profile', 'view_tasks'] });
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

function followUpPath(ctx, suffix = '') {
  return `/api/episodes/${ctx.episode.id}/follow-ups${suffix}`;
}

const FOLLOW_UP = {
  date: '',
  time: '10:30',
  timezone: ZONE,
  location: 'Ward 4, City Hospital',
  contactName: 'Surgical outpatient team',
  contactPhone: '+441234567890',
  note: 'Bring the dressing pack you were given.',
  reminder: { enabled: true, localTime: '09:00', daysBefore: 1 },
};

async function prescribe(ctx, body = {}, agent = ctx.coordCtx) {
  return agent.a
    .post(followUpPath(ctx))
    .set('X-CSRF-Token', agent.csrf)
    .send({ ...FOLLOW_UP, date: zoneDate(3), ...body });
}

test('the team prescribes a follow-up and the patient reads exactly what was prescribed', async () => {
  const ctx = await setup();
  const created = await prescribe(ctx);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const followUp = created.body.followUp;
  assert.equal(followUp.status, 'scheduled');
  assert.equal(followUp.location, 'Ward 4, City Hospital');
  assert.equal(followUp.contact.name, 'Surgical outpatient team');
  assert.equal(followUp.reminder.enabled, true);
  // The reminder appears the day BEFORE the appointment, computed from the date.
  assert.equal(followUp.reminder.appearsOn, zoneDate(2));
  assert.match(followUp.note_wording, /no test results, no reports and no referral/i);
  assert.match(followUp.reminderNote, /not a result/i);

  const patient = await ctx.patientCtx.a.get('/api/patient/me/follow-ups?page=1&limit=10');
  assert.equal(patient.status, 200, JSON.stringify(patient.body));
  assert.equal(patient.body.total, 1);
  assert.equal(patient.body.items[0].location, 'Ward 4, City Hospital');
  assert.equal(patient.body.items[0].note, 'Bring the dressing pack you were given.');

  // Rescheduling moves the prescribed details and bumps the revision.
  const moved = await ctx.coordCtx.a
    .patch(followUpPath(ctx, `/${followUp.id}`))
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ date: zoneDate(5), location: 'Ward 4, City Hospital (new entrance)' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.followUp.revision, 2);
  assert.equal(moved.body.followUp.reminder.appearsOn, zoneDate(4));

  const cancelled = await ctx.coordCtx.a
    .post(followUpPath(ctx, `/${followUp.id}/cancel`))
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ reason: 'Rearranged by the clinic.' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.followUp.status, 'cancelled');
  // A cancelled follow-up is frozen.
  const editCancelled = await ctx.coordCtx.a
    .patch(followUpPath(ctx, `/${followUp.id}`))
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ location: 'Somewhere else' });
  assert.equal(editCancelled.status, 409);
});

test('a follow-up is a date, a place and a contact: results, reports and referrals are refused', async () => {
  const ctx = await setup();

  // A field that belongs to a workflow this part does not implement has nowhere
  // to arrive, so the request is refused outright.
  const withResult = await prescribe(ctx, { testResult: 'Negative' });
  assert.equal(withResult.status, 400, JSON.stringify(withResult.body));
  const withReferral = await prescribe(ctx, { referralTo: 'Orthopaedics' });
  assert.equal(withReferral.status, 400);
  const withReport = await prescribe(ctx, { reportId: 'RPT-1' });
  assert.equal(withReport.status, 400);
  assert.equal(await harness.models.FollowUpPlan.countDocuments({}), 0);

  // And wording that describes a results or referral workflow is refused even
  // when it arrives in a permitted field.
  const referralWording = await prescribe(ctx, {
    note: 'A referral will be made to the specialist team.',
  });
  assert.equal(referralWording.status, 400, JSON.stringify(referralWording.body));
  assert.match(referralWording.body.error.message, /Results, reports, referrals/i);

  const resultsWording = await prescribe(ctx, { location: 'Collect the test results from Ward 4' });
  assert.equal(resultsWording.status, 400);

  const missingDate = await prescribe(ctx, { date: undefined });
  assert.equal(missingDate.status, 400);

  const badDate = await prescribe(ctx, { date: 'next Tuesday' });
  assert.equal(badDate.status, 400);

  const badZone = await prescribe(ctx, { timezone: 'Mars/Olympus' });
  assert.equal(badZone.status, 400);

  const badReminder = await prescribe(ctx, { reminder: { daysBefore: 90 } });
  assert.equal(badReminder.status, 400);

  const unknownReminder = await prescribe(ctx, { reminder: { sms: true } });
  assert.equal(unknownReminder.status, 400);
});

test('only the assigned care team prescribes, and only in its own episode', async () => {
  const ctx = await setup();

  assert.equal((await prescribe(ctx, {}, ctx.coord2Ctx)).status, 403, 'unassigned coordinator');
  assert.equal((await prescribe(ctx, {}, ctx.adminCtx)).status, 403, 'administrator');
  assert.equal((await prescribe(ctx, {}, ctx.patientCtx)).status, 403, 'patient');
  assert.equal((await prescribe(ctx, {}, ctx.otherClinicCtx)).status, 404, 'another clinic');
  assert.equal((await ctx.coord2Ctx.a.get(followUpPath(ctx))).status, 403);
  assert.equal((await ctx.adminCtx.a.get(followUpPath(ctx))).status, 403);
  assert.equal((await ctx.otherClinicCtx.a.get(followUpPath(ctx))).status, 404);

  // Prescribing a follow-up is OPERATIONAL work, so the reviewer - who is on the
  // episode but holds no episode.manage permission - is refused. Drafting and
  // clinical authority stay separate here exactly as they do for plans.
  const byReviewer = await prescribe(ctx, {}, ctx.reviewerCtx);
  assert.equal(byReviewer.status, 403, JSON.stringify(byReviewer.body));

  const byAssignee = await prescribe(ctx);
  assert.equal(byAssignee.status, 201, JSON.stringify(byAssignee.body));

  // A closed episode takes no new follow-ups but keeps the history readable.
  await harness.models.RecoveryEpisode.updateOne(
    { _id: ctx.episode.id },
    { $set: { status: 'closed' } }
  );
  const blocked = await prescribe(ctx);
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.match(blocked.body.error.message, /closed/i);
  const readable = await ctx.coordCtx.a.get(followUpPath(ctx));
  assert.equal(readable.status, 200);
  assert.equal(readable.body.total, 1);
  // The reviewer may still READ the episode's follow-ups.
  assert.equal((await ctx.reviewerCtx.a.get(followUpPath(ctx))).status, 200);
});

test('a caregiver reads follow-ups only with the scope, and only for their patient', async () => {
  const ctx = await setup({ withCaregiver: true });
  await prescribe(ctx);

  const listed = await ctx.caregiverCtx.a.get(
    `/api/caregiver/me/patients/${ctx.patient.id}/follow-ups?page=1&limit=10`
  );
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.total, 1);

  await harness.models.CaregiverGrant.updateOne(
    { _id: ctx.grantId },
    { $set: { scopes: ['view_profile'] } }
  );
  const withoutScope = await ctx.caregiverCtx.a.get(
    `/api/caregiver/me/patients/${ctx.patient.id}/follow-ups`
  );
  assert.equal(withoutScope.status, 404);
});

test('the in-app reminder appears on the day the clinic chose', async () => {
  const ctx = await setup();
  // A follow-up whose reminder date is TODAY: it is due to be queued.
  const created = await prescribe(ctx, {
    date: zoneDate(1),
    reminder: { enabled: true, localTime: '09:00', daysBefore: 1 },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.followUp.reminder.appearsOn, zoneDate(0));

  const queued = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/reminders/queue`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ kinds: ['follow_up'] });
  assert.equal(queued.status, 201, JSON.stringify(queued.body));
  assert.equal(queued.body.summary.queued, 1);

  const notification = await harness.models.Notification.findOne({ kind: 'follow_up' }).lean();
  assert.ok(notification);
  assert.equal(notification.sourceType, 'follow_up');
  assert.equal(notification.localDate, zoneDate(1));
  assert.match(notification.body, /follow-up on/i);
  assert.match(notification.body, /Ward 4, City Hospital/);
  // A reminder is not a result and says nothing about what the appointment is for.
  assert.ok(!/result|report|referral/i.test(notification.body));

  // Queueing again changes nothing.
  const again = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/reminders/queue`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ kinds: ['follow_up'] });
  assert.equal(again.body.summary.queued, 0);
  assert.equal(again.body.summary.duplicates, 1);

  const delivered = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/reminders/deliver`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({});
  assert.equal(delivered.body.summary.delivered, 1);

  // A reminder far in the future is not queued early.
  const later = await prescribe(ctx, {
    date: zoneDate(20),
    reminder: { enabled: true, localTime: '09:00', daysBefore: 1 },
  });
  assert.equal(later.status, 201);
  const third = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/reminders/queue`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ kinds: ['follow_up'] });
  assert.equal(third.body.summary.queued, 0, 'a future appointment does not queue a reminder today');

  // A cancelled follow-up stops its reminder before delivery.
  await harness.models.FollowUpPlan.updateOne(
    { _id: created.body.followUp.id },
    { $set: { status: 'scheduled', date: zoneDate(1) } }
  );
  await harness.models.Notification.updateOne(
    { _id: notification._id },
    { $set: { state: 'queued', deliveredAt: null, nextAttemptAt: new Date(Date.now() - 1000) } }
  );
  await harness.models.FollowUpPlan.updateOne(
    { _id: created.body.followUp.id },
    { $set: { status: 'cancelled' } }
  );
  const stopped = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/reminders/deliver`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({});
  assert.equal(stopped.body.summary.skipped, 1, JSON.stringify(stopped.body));
});
