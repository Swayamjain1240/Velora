'use strict';

// Part 8 exit gate: recovery check-ins against a real replica-set MongoDB.
//
// The assertions the part turns on: a slot is materialised idempotently, an
// answer is append-only and cannot be duplicated, a LATE answer is still an
// answer, a MISSING answer is derived and never classified, a clinic rule means
// workflow attention for a person, and every denial path (admin, unassigned
// staff, another clinic, a caregiver without the scope, a revoked grant, a
// closed episode) is exercised.
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

const ZONE = 'Europe/London';

function zoneDate(offsetDays = 0) {
  return zonedTime.addDays(zonedTime.todayInTimezone(ZONE), offsetDays);
}

// A clinic-defined template whose first interval has already closed (a MISSING
// slot) and whose later intervals are still answerable (a DUE slot).
const TEMPLATE = {
  key: 'post-op-wound',
  title: 'Post-operative wound check',
  description: 'Daily wound checks after discharge.',
  questions: [
    {
      id: 'pain_level',
      prompt: 'How would you rate your pain today?',
      kind: 'scale',
      scaleMin: 0,
      scaleMax: 10,
    },
    {
      id: 'wound_state',
      prompt: 'Is the wound area red, hot or leaking?',
      kind: 'choice',
      options: ['no', 'red', 'hot', 'leaking'],
    },
  ],
  cadence: { startOffsetDays: 1, everyDays: 1, horizonDays: 3 },
  responseWindowHours: 24,
  reviewRules: [
    {
      id: 'pain_high',
      label: 'Pain score was high - a clinician should look at this',
      when: { questionId: 'pain_level', operator: 'at_least', value: 7 },
    },
  ],
};

async function setup({ dischargeOffsetDays = -2, withCaregiver = false } = {}) {
  const a = await harness.makeClinic({ codePrefix: 'CHKA' });
  const b = await harness.makeClinic({ codePrefix: 'CHKB' });
  const ctx = { clinic: a.clinic, otherClinic: b.clinic };

  const coord = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  ctx.coord = coord;
  ctx.coordCtx = await harness.signInStaff(app, coord.user.email);
  // A same-clinic coordinator who is NOT assigned to this episode.
  const coord2 = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  ctx.coord2Ctx = await harness.signInStaff(app, coord2.user.email);

  const reviewer = await harness.makeMember(a.clinic, {
    roleKey: 'clinical_reviewer',
    eligibility: 'verified',
  });
  ctx.reviewer = reviewer;
  ctx.reviewerCtx = await harness.signInStaff(app, reviewer.user.email);
  const pending = await harness.makeMember(a.clinic, { roleKey: 'clinical_reviewer' });
  ctx.pendingReviewerCtx = await harness.signInStaff(app, pending.user.email);
  const unassignedReviewer = await harness.makeMember(a.clinic, {
    roleKey: 'clinical_reviewer',
    eligibility: 'verified',
  });
  ctx.unassignedReviewer = unassignedReviewer;
  ctx.unassignedReviewerCtx = await harness.signInStaff(app, unassignedReviewer.user.email);
  ctx.adminCtx = await harness.signInStaff(app, a.admin.user.email);

  const otherCoord = await harness.makeMember(b.clinic, { roleKey: 'care_coordinator' });
  ctx.otherClinicCtx = await harness.signInStaff(app, otherCoord.user.email);

  const created = await harness.createPatient(ctx.coordCtx.a, ctx.coordCtx.csrf, {
    fullName: 'Synthetic Check-in Patient',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ctx.patient = created.body.patient;

  const episodeRes = await ctx.coordCtx.a
    .post('/api/episodes')
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({
      patientId: ctx.patient.id,
      dischargeDate: zoneDate(dischargeOffsetDays),
      dischargeTimezone: ZONE,
    });
  assert.equal(episodeRes.status, 201, JSON.stringify(episodeRes.body));
  ctx.episode = episodeRes.body.episode;

  // The patient's own account, linked by ownership.
  const patientUser = await harness.makeMember(a.clinic, { roleKey: 'patient' });
  await harness.models.PatientProfile.updateOne(
    { _id: ctx.patient.id },
    { $set: { linkedUserId: patientUser.user.id, status: 'active' } }
  );
  ctx.patientCtx = await harness.signInStaff(app, patientUser.user.email);

  // The assigned verified reviewer (activation + review authority).
  const assigned = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/team`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ memberUserId: reviewer.user.id, responsibility: 'clinical_reviewer' });
  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));

  if (withCaregiver) {
    const caregiver = await grantCaregiver(ctx, ['view_profile', 'view_checkins', 'log_checkins']);
    ctx.caregiverCtx = caregiver;
    ctx.grantId = caregiver.grant.id;
  }
  return ctx;
}

async function grantCaregiver(ctx, scopes) {
  const email = `caregiver-${Date.now()}-${Math.random().toString(16).slice(2, 6)}@synthetic.invalid`;
  const invited = await ctx.coordCtx.a
    .post(`/api/patients/${ctx.patient.id}/caregivers`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ email, scopes });
  assert.equal(invited.status, 201, JSON.stringify(invited.body));
  const accepted = await harness.agent(app).post('/api/access/caregiver-invitation').send({
    token: invited.body.invitation.token,
    password: 'SyntheticCarePass!24',
    name: 'Synthetic Caregiver',
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const signedIn = await harness.signInStaff(app, email, 'SyntheticCarePass!24');
  return { ...signedIn, grant: accepted.body.grant };
}

async function activateTemplate(ctx) {
  const created = await ctx.coordCtx.a
    .post('/api/check-in-templates')
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send(TEMPLATE);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const activated = await ctx.reviewerCtx.a
    .post(`/api/check-in-templates/${created.body.template.id}/activate`)
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({ expectedRevision: 1, note: 'Clinic rules reviewed.' });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  return created.body.template.id;
}

function checkInPath(ctx, suffix = '') {
  return `/api/episodes/${ctx.episode.id}/check-ins${suffix}`;
}

async function materialise(ctx, agent = ctx.coordCtx) {
  return agent.a
    .post(`${checkInPath(ctx, '/materialise')}`)
    .set('X-CSRF-Token', agent.csrf)
    .send({});
}

async function list(ctx, query = {}, agent = ctx.coordCtx) {
  const params = new URLSearchParams({ page: 1, limit: 20, ...query });
  return agent.a.get(`${checkInPath(ctx)}?${params.toString()}`);
}

// The scenarios below need one slot whose response window has ALREADY closed,
// because a MISSING slot is DERIVED from the stored timing facts rather than
// stored as a state (`checkInPolicy.slotView` compares windowEndsAt with now).
// Leaving that to the decorated 09:00 due time would make the suite pass only at
// certain hours, so the fixture closes the window explicitly. The slot stays
// 'open' in the database: only the timing fact changes, which is exactly the
// input the derivation is under test against. `dueAt` is immutable by design and
// is deliberately left alone.
const WINDOW_MS = 24 * 60 * 60 * 1000;

async function expireOldestSlot(ctx) {
  const now = Date.now();
  const result = await harness.models.CheckInResponse.updateOne(
    { episode: ctx.episode.id, slotKey: `post-op-wound@${zoneDate(-1)}` },
    { $set: { windowEndsAt: new Date(now - WINDOW_MS) } }
  );
  assert.equal(result.matchedCount, 1, 'the oldest slot exists to be expired');
}

// The patient answers through their OWN namespace; the staff route is a separate
// surface with different permissions, so a test must name which one it exercises.
async function patientAnswer(ctx, responseId, answers) {
  return ctx.patientCtx.a
    .post(`/api/patient/me/check-ins/${responseId}/submit`)
    .set('X-CSRF-Token', ctx.patientCtx.csrf)
    .send({ answers });
}

async function staffAnswer(ctx, responseId, answers, agent = ctx.coordCtx) {
  return agent.a
    .post(`${checkInPath(ctx, `/${responseId}/submit`)}`)
    .set('X-CSRF-Token', agent.csrf)
    .send({ answers });
}

const GOOD_ANSWERS = [
  { questionId: 'pain_level', value: 3 },
  { questionId: 'wound_state', value: 'no' },
];

test('materialising slots is idempotent and one template interval becomes one slot', async () => {
  const ctx = await setup();
  await activateTemplate(ctx);

  const first = await materialise(ctx);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  // day-1, day 0, day+1 and day+2 fit inside a 3-day horizon starting a day
  // after discharge two days ago.
  assert.equal(first.body.summary.created, 4);
  assert.equal(first.body.summary.templates[0].key, 'post-op-wound');
  assert.equal(first.body.summary.templates[0].version, 1);

  const again = await materialise(ctx);
  assert.equal(again.status, 201);
  assert.equal(again.body.summary.created, 0, 'a second run creates nothing');
  assert.equal(await harness.models.CheckInResponse.countDocuments({}), 4);

  // Slot identity is the clinic template key plus the LOCAL date, in the
  // episode's own timezone.
  const stored = await harness.models.CheckInResponse.find({}).sort({ dueAt: 1 }).lean();
  assert.equal(stored[0].slotKey, `post-op-wound@${zoneDate(-1)}`);
  assert.equal(stored[0].timezone, ZONE);
  assert.equal(stored[0].state, 'open');
  assert.equal(stored[0].windowEndsAt.getTime() - stored[0].dueAt.getTime(), 24 * 3600 * 1000);
});

test('a missing response is derived, stays missing, and is never classified', async () => {
  const ctx = await setup();
  await activateTemplate(ctx);
  await materialise(ctx);

  await expireOldestSlot(ctx);

  const all = await list(ctx);
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.equal(all.body.total, 4);
  assert.equal(all.body.summary.no_response, 1, 'only the closed interval is missing');
  assert.equal(all.body.summary.due, 3);

  const missing = await list(ctx, { view: 'no_response' });
  assert.equal(missing.body.total, 1);
  const slot = missing.body.items[0];
  assert.equal(slot.state, 'no_response');
  assert.equal(slot.isMissing, true);
  assert.equal(slot.answers.length, 0);
  assert.match(slot.note, /nothing is inferred/i);
  assert.match(slot.note, /not a normal result, not an abnormal result/i);
  assert.equal(slot.reviewState, 'none', 'silence never opens a review');

  // Nothing anywhere in the payload calls a missing check-in normal, abnormal or
  // an interpretation of recovery.
  const serialised = JSON.stringify(missing.body).toLowerCase();
  assert.ok(!/abnormal recovery|is normal recovery|deteriorat/.test(serialised));

  // The due view is what a patient can still answer.
  const due = await list(ctx, { view: 'due' });
  assert.equal(due.body.total, 3);
  assert.deepEqual(due.body.summary, all.body.summary);
  assert.match(due.body.guidance.note, /not monitored continuously|not published/i);
});

test('an answer is append-only: a duplicate submission is refused, not overwritten', async () => {
  const ctx = await setup();
  await activateTemplate(ctx);
  await materialise(ctx);
  const due = await list(ctx, { view: 'due' });
  const slot = due.body.items[0];

  const first = await patientAnswer(ctx, slot.id, GOOD_ANSWERS);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.response.state, 'submitted');
  assert.equal(first.body.response.submittedByRole, 'patient');
  assert.equal(first.body.response.reviewState, 'none');
  assert.equal(first.body.response.isLate, false);
  assert.deepEqual(
    first.body.response.answers.map((a) => a.questionId).sort(),
    ['pain_level', 'wound_state']
  );

  const duplicate = await patientAnswer(ctx, slot.id, [
    { questionId: 'pain_level', value: 10 },
    { questionId: 'wound_state', value: 'leaking' },
  ]);
  assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
  assert.match(duplicate.body.error.message, /already been answered/i);

  const stored = await harness.models.CheckInResponse.findById(slot.id).lean();
  assert.equal(stored.answers.find((a) => a.questionId === 'pain_level').value, '3');

  // The model itself refuses an edit even if a future service tries one.
  const doc = await harness.models.CheckInResponse.findById(slot.id);
  doc.set({ answers: [{ questionId: 'pain_level', kind: 'scale', value: '0' }] });
  await assert.rejects(() => doc.save(), /append-only/i);
});

test('a late answer is still an answer, recorded with the timing fact', async () => {
  const ctx = await setup();
  await activateTemplate(ctx);
  await materialise(ctx);
  await expireOldestSlot(ctx);
  const missing = await list(ctx, { view: 'no_response' });
  const slot = missing.body.items[0];
  assert.equal(slot.state, 'no_response');

  const late = await patientAnswer(ctx, slot.id, [
    { questionId: 'pain_level', value: 4 },
    { questionId: 'wound_state', value: 'red' },
  ]);
  assert.equal(late.status, 200, JSON.stringify(late.body));
  assert.equal(late.body.response.isLate, true);
  assert.equal(late.body.response.state, 'submitted');
  assert.match(late.body.response.note, /timing fact/i);

  // It is a submission now, and the miss is no longer reported as missing.
  const after = await list(ctx, { view: 'no_response' });
  assert.equal(after.body.total, 0);
  assert.equal(after.body.summary.late, 1);
});

test('a clinic rule turns into workflow attention for a person, never a diagnosis', async () => {
  const ctx = await setup();
  await activateTemplate(ctx);
  await materialise(ctx);
  const due = await list(ctx, { view: 'due' });
  const slot = due.body.items[0];

  const submitted = await patientAnswer(ctx, slot.id, [
    { questionId: 'pain_level', value: 8 },
    { questionId: 'wound_state', value: 'leaking' },
  ]);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(submitted.body.response.reviewState, 'needs_review');
  assert.equal(submitted.body.response.triggeredRules.length, 1);
  assert.equal(submitted.body.response.triggeredRules[0].id, 'pain_high');
  assert.match(submitted.body.response.attentionNote, /not a diagnosis/i);
  assert.match(submitted.body.attention.note, /workflow attention, not a diagnosis/i);
  assert.equal(submitted.body.response.reviewedAt, null);

  // The response itself carries no score, severity or verdict.
  const serialised = JSON.stringify(submitted.body).toLowerCase();
  assert.ok(!/"severity"|"diagnosis":|"abnormal":true/.test(serialised));

  const queue = await list(ctx, { view: 'needs_review' });
  assert.equal(queue.body.total, 1);

  // Only the assigned, verified clinical reviewer may close it.
  const byCoordinator = await ctx.coordCtx.a
    .post(`${checkInPath(ctx, `/${slot.id}/review`)}`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ note: 'Looks fine.' });
  assert.equal(byCoordinator.status, 403);

  const byPending = await ctx.pendingReviewerCtx.a
    .post(`${checkInPath(ctx, `/${slot.id}/review`)}`)
    .set('X-CSRF-Token', ctx.pendingReviewerCtx.csrf)
    .send({ note: 'Reviewed.' });
  assert.equal(byPending.status, 403, 'reviewer eligibility must be verified');

  const byUnassigned = await ctx.unassignedReviewerCtx.a
    .post(`${checkInPath(ctx, `/${slot.id}/review`)}`)
    .set('X-CSRF-Token', ctx.unassignedReviewerCtx.csrf)
    .send({ note: 'Reviewed.' });
  assert.equal(byUnassigned.status, 403, 'review needs an active assignment on this episode');

  const byAdmin = await ctx.adminCtx.a
    .post(`${checkInPath(ctx, `/${slot.id}/review`)}`)
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({ note: 'Reviewed.' });
  assert.equal(byAdmin.status, 403);

  const reviewed = await ctx.reviewerCtx.a
    .post(`${checkInPath(ctx, `/${slot.id}/review`)}`)
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({ note: 'Called the patient; wound check arranged.' });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  assert.equal(reviewed.body.response.reviewState, 'reviewed');
  assert.equal(reviewed.body.response.reviewedByLabel, ctx.reviewer.user.email);

  const again = await ctx.reviewerCtx.a
    .post(`${checkInPath(ctx, `/${slot.id}/review`)}`)
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({ note: 'Once more.' });
  assert.equal(again.status, 409, 'a reviewed response is closed for further review');

  // A rule with no trigger cannot be reviewed at all: there is nothing to review.
  const due2 = await list(ctx, { view: 'due' });
  const calm = await patientAnswer(ctx, due2.body.items[0].id, GOOD_ANSWERS);
  assert.equal(calm.body.response.reviewState, 'none');
  const pointless = await ctx.reviewerCtx.a
    .post(`${checkInPath(ctx, `/${calm.body.response.id}/review`)}`)
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({ note: 'Nothing to review.' });
  assert.equal(pointless.status, 409);
});

test('the patient answers their own check-ins and cannot answer anyone else’s', async () => {
  const ctx = await setup();
  await activateTemplate(ctx);
  await materialise(ctx);
  await expireOldestSlot(ctx);

  // The patient's own mobile queue reads across their profile, scoped by
  // ownership, and carries the questions for an answerable slot only.
  const mine = await ctx.patientCtx.a.get('/api/patient/me/check-ins?page=1&limit=10');
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.total, 4);
  const dueSlot = mine.body.items.find((i) => i.state === 'open');
  assert.ok(dueSlot.questions.length === 2);
  const missingSlot = mine.body.items.find((i) => i.state === 'no_response');
  assert.equal(missingSlot.questions, null, 'a closed slot carries no form');
  assert.match(mine.body.guidance.note, /response hours|not published/i);

  // Another patient's slot is a 404 for this account.
  const otherClinic = await harness.makeClinic({ codePrefix: 'CHKC' });
  const otherUser = await harness.makeMember(otherClinic.clinic, { roleKey: 'patient' });
  const otherCtx = await harness.signInStaff(app, otherUser.user.email);
  const cross = await otherCtx.a
    .post(`/api/patient/me/check-ins/${dueSlot.id}/submit`)
    .set('X-CSRF-Token', otherCtx.csrf)
    .send({ answers: GOOD_ANSWERS });
  assert.equal(cross.status, 404, 'the slot is invisible outside its own clinic');

  // Staff cannot answer as the patient through the patient namespace either.
  const asStaff = await ctx.coordCtx.a
    .post(`/api/patient/me/check-ins/${dueSlot.id}/submit`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ answers: GOOD_ANSWERS });
  assert.equal(asStaff.status, 403, 'a staff membership holds no patient.self permission');

  // And the patient cannot reach the staff surface either.
  const staffSurface = await staffAnswer(ctx, dueSlot.id, GOOD_ANSWERS, ctx.patientCtx);
  assert.equal(staffSurface.status, 403, 'the staff check-in surface is closed to a patient');
});

test('an answer is validated against the version that asked the questions', async () => {
  const ctx = await setup();
  await activateTemplate(ctx);
  await materialise(ctx);
  const due = await list(ctx, { view: 'due' });
  const slot = due.body.items[0];

  const invented = await patientAnswer(ctx, slot.id, [
    { questionId: 'pain_level', value: 3 },
    { questionId: 'wound_state', value: 'no' },
    { questionId: 'not_a_question', value: 'hello' },
  ]);
  assert.equal(invented.status, 400, JSON.stringify(invented.body));

  const wrongOption = await patientAnswer(ctx, slot.id, [
    { questionId: 'pain_level', value: 3 },
    { questionId: 'wound_state', value: 'infected' },
  ]);
  assert.equal(wrongOption.status, 400);

  const offScale = await patientAnswer(ctx, slot.id, [
    { questionId: 'pain_level', value: 42 },
    { questionId: 'wound_state', value: 'no' },
  ]);
  assert.equal(offScale.status, 400);

  const extraField = await patientAnswer(ctx, slot.id, [
    { questionId: 'pain_level', value: 3, medication: 'ibuprofen' },
    { questionId: 'wound_state', value: 'no' },
  ]);
  assert.equal(extraField.status, 400, 'unknown fields are refused');

  const blank = await patientAnswer(ctx, slot.id, [{ questionId: 'wound_state', value: 'no' }]);
  assert.equal(blank.status, 400, 'a required question cannot be skipped');

  assert.equal(
    (await harness.models.CheckInResponse.findById(slot.id).lean()).state,
    'open',
    'a refused submission changes nothing'
  );
});

test('assigned staff may record an answer, unassigned staff and admins may not', async () => {
  const ctx = await setup();
  await activateTemplate(ctx);
  await materialise(ctx);
  const due = await list(ctx, { view: 'due' });
  const slot = due.body.items[0];

  const unassignedRead = await list(ctx, {}, ctx.coord2Ctx);
  assert.equal(unassignedRead.status, 403, 'an unassigned colleague sees an explicit refusal');

  const unassignedSubmit = await staffAnswer(ctx, slot.id, GOOD_ANSWERS, ctx.coord2Ctx);
  assert.equal(unassignedSubmit.status, 403);

  const adminRead = await ctx.adminCtx.a.get(checkInPath(ctx));
  assert.equal(adminRead.status, 403, 'admin status alone cannot browse clinical content');
  const adminMaterialise = await materialise(ctx, ctx.adminCtx);
  assert.equal(adminMaterialise.status, 403);

  const otherClinicRead = await ctx.otherClinicCtx.a.get(checkInPath(ctx));
  assert.equal(otherClinicRead.status, 404, 'the episode is not scoped to another clinic');

  // The assigned coordinator records what the patient said on the phone.
  const byStaff = await staffAnswer(ctx, slot.id, GOOD_ANSWERS, ctx.coordCtx);
  assert.equal(byStaff.status, 200, JSON.stringify(byStaff.body));
  assert.equal(byStaff.body.response.submittedByRole, 'team');
  assert.equal(byStaff.body.response.submittedByLabel, ctx.coord.user.email);
});

test('a caregiver needs both check-in scopes, and the clinic comes from the grant', async () => {
  const ctx = await setup({ withCaregiver: true });
  await activateTemplate(ctx);
  await materialise(ctx);

  const caregiverList = await ctx.caregiverCtx.a.get(
    `/api/caregiver/me/patients/${ctx.patient.id}/check-ins?page=1&limit=10`
  );
  assert.equal(caregiverList.status, 200, JSON.stringify(caregiverList.body));
  assert.equal(caregiverList.body.total, 4);

  const dueSlot = caregiverList.body.items.find((i) => i.state === 'open');
  const answered = await ctx.caregiverCtx.a
    .post(`/api/caregiver/me/check-ins/${dueSlot.id}/submit`)
    .set('X-CSRF-Token', ctx.caregiverCtx.csrf)
    .send({ answers: GOOD_ANSWERS });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal(answered.body.response.submittedByRole, 'caregiver');

  const stored = await harness.models.CheckInResponse.findById(dueSlot.id).lean();
  assert.equal(String(stored.submittedByGrant), ctx.grantId);
  assert.equal(String(stored.clinic), String(ctx.clinic._id));

  // Dropping a scope closes the surface: the caregiver learns nothing about the
  // record rather than receiving a partial view.
  await harness.models.CaregiverGrant.updateOne(
    { _id: ctx.grantId },
    { $set: { scopes: ['view_profile', 'view_checkins'] } }
  );
  const cannotLog = await ctx.caregiverCtx.a
    .post(`/api/caregiver/me/check-ins/${caregiverList.body.items[1].id}/submit`)
    .set('X-CSRF-Token', ctx.caregiverCtx.csrf)
    .send({ answers: GOOD_ANSWERS });
  assert.equal(cannotLog.status, 404);

  await harness.models.CaregiverGrant.updateOne(
    { _id: ctx.grantId },
    { $set: { scopes: ['view_profile', 'log_checkins'] } }
  );
  const cannotRead = await ctx.caregiverCtx.a.get(
    `/api/caregiver/me/patients/${ctx.patient.id}/check-ins`
  );
  assert.equal(cannotRead.status, 404);

  // A revoked grant closes both.
  await harness.models.CaregiverGrant.updateOne(
    { _id: ctx.grantId },
    { $set: { scopes: ['view_profile', 'view_checkins', 'log_checkins'] } }
  );
  await harness.models.CaregiverGrant.updateOne(
    { _id: ctx.grantId },
    { $set: { status: 'revoked', revokedAt: new Date() } }
  );
  const revokedRead = await ctx.caregiverCtx.a.get(
    `/api/caregiver/me/patients/${ctx.patient.id}/check-ins`
  );
  assert.equal(revokedRead.status, 404);
});

test('a closed episode stops answering but keeps the check-in history readable', async () => {
  const ctx = await setup();
  await activateTemplate(ctx);
  await materialise(ctx);
  const due = await list(ctx, { view: 'due' });
  const slot = due.body.items[0];
  const answered = await patientAnswer(ctx, slot.id, GOOD_ANSWERS);
  assert.equal(answered.status, 200);

  await harness.models.RecoveryEpisode.updateOne(
    { _id: ctx.episode.id },
    { $set: { status: 'closed' } }
  );

  const blockedMaterialise = await materialise(ctx);
  assert.equal(blockedMaterialise.status, 409, JSON.stringify(blockedMaterialise.body));
  assert.match(blockedMaterialise.body.error.message, /closed/i);

  const blockedAnswer = await patientAnswer(ctx, due.body.items[1].id, GOOD_ANSWERS);
  assert.equal(blockedAnswer.status, 409, JSON.stringify(blockedAnswer.body));
  assert.match(blockedAnswer.body.error.message, /closed/i);

  const readable = await list(ctx);
  assert.equal(readable.status, 200, JSON.stringify(readable.body));
  const row = readable.body.items.find((i) => i.id === slot.id);
  assert.equal(row.state, 'submitted');
  assert.equal(row.answers.length, 2);
});

test('invalid identifiers and filters are refused before any read', async () => {
  const ctx = await setup();
  await activateTemplate(ctx);
  await materialise(ctx);

  const badId = await ctx.coordCtx.a.get(
    `/api/episodes/${ctx.episode.id}/check-ins/not-an-id`
  );
  assert.equal(badId.status, 400);

  const badView = await ctx.coordCtx.a.get(`${checkInPath(ctx)}?view=everything`);
  assert.equal(badView.status, 400);

  const badPage = await ctx.coordCtx.a.get(`${checkInPath(ctx)}?page=0&limit=20`);
  assert.equal(badPage.status, 400);

  const badAnswer = await patientAnswer(ctx, (await list(ctx, { view: 'due' })).body.items[0].id, [
    { questionId: 'pain_level', value: 3 },
    { questionId: 'wound_state', value: 'no', extra: 1 },
  ]);
  assert.equal(badAnswer.status, 400);

  // No client-supplied clinic can widen the scope.
  const smuggled = await ctx.coordCtx.a.get(
    `${checkInPath(ctx)}?clinicId=${ctx.otherClinic._id}&view=due`
  );
  assert.equal(smuggled.status, 400, 'unknown query fields are rejected');
});
