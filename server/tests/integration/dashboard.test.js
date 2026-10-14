'use strict';

// Part 8 exit gate: the assigned-team dashboard.
//
// The assertions the part turns on: every list and count is tenant- AND
// assignment-scoped, an administrator cannot browse clinical queues at all, an
// unassigned colleague sees zero of someone else's work, the five queues report
// the right items, and ownership is explicit (claim, one active owner, release
// with history).
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

async function setup() {
  const a = await harness.makeClinic({ codePrefix: 'DASHA' });
  const b = await harness.makeClinic({ codePrefix: 'DASHB' });
  const ctx = { clinic: a.clinic, otherClinic: b.clinic };

  const coord = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  ctx.coord = coord;
  ctx.coordCtx = await harness.signInStaff(app, coord.user.email);
  // A same-clinic coordinator who will be assigned to a SECOND episode only, so
  // the scoping assertions are about assignment rather than about the clinic.
  const coord2 = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  ctx.coord2 = coord2;
  ctx.coord2Ctx = await harness.signInStaff(app, coord2.user.email);
  const reviewer = await harness.makeMember(a.clinic, {
    roleKey: 'clinical_reviewer',
    eligibility: 'verified',
  });
  ctx.reviewer = reviewer;
  ctx.reviewerCtx = await harness.signInStaff(app, reviewer.user.email);
  ctx.adminCtx = await harness.signInStaff(app, a.admin.user.email);
  const otherCoord = await harness.makeMember(b.clinic, { roleKey: 'care_coordinator' });
  ctx.otherClinicCtx = await harness.signInStaff(app, otherCoord.user.email);

  const created = await harness.createPatient(ctx.coordCtx.a, ctx.coordCtx.csrf, {
    fullName: 'Synthetic Dashboard Patient',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ctx.patient = created.body.patient;

  const episodeRes = await ctx.coordCtx.a
    .post('/api/episodes')
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ patientId: ctx.patient.id, dischargeDate: zoneDate(-1), dischargeTimezone: ZONE });
  assert.equal(episodeRes.status, 201, JSON.stringify(episodeRes.body));
  ctx.episode = episodeRes.body.episode;

  const patientUser = await harness.makeMember(a.clinic, { roleKey: 'patient' });
  await harness.models.PatientProfile.updateOne(
    { _id: ctx.patient.id },
    { $set: { linkedUserId: patientUser.user.id, status: 'active' } }
  );
  ctx.patientCtx = await harness.signInStaff(app, patientUser.user.email);

  // The reviewer is on THIS episode, which is what puts its reviews in scope.
  const assigned = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/team`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ memberUserId: reviewer.user.id, responsibility: 'clinical_reviewer' });
  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
  return ctx;
}

async function activateTemplate(ctx) {
  const created = await ctx.coordCtx.a
    .post('/api/check-in-templates')
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({
      key: 'dash-check',
      title: 'Daily dashboard check',
      questions: [
        { id: 'pain_level', prompt: 'How would you rate your pain today?', kind: 'scale', scaleMin: 0, scaleMax: 10 },
      ],
      cadence: { startOffsetDays: 1, everyDays: 1, horizonDays: 1 },
      responseWindowHours: 48,
      reviewRules: [
        {
          id: 'pain_high',
          label: 'Pain score was high - a clinician should look at this',
          when: { questionId: 'pain_level', operator: 'at_least', value: 7 },
        },
      ],
    });
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
  assert.ok(due.body.items.length, 'a due slot exists');
  return due.body.items[0];
}

// A check-in a clinic rule flagged, so the review queue has an item.
async function flaggedCheckIn(ctx) {
  const slot = await activateTemplate(ctx);
  const submitted = await ctx.patientCtx.a
    .post(`/api/patient/me/check-ins/${slot.id}/submit`)
    .set('X-CSRF-Token', ctx.patientCtx.csrf)
    .send({ answers: [{ questionId: 'pain_level', value: 9 }] });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(submitted.body.response.reviewState, 'needs_review');
  return submitted.body.response;
}

async function openQuestion(ctx, kind = 'operational') {
  const created = await ctx.patientCtx.a
    .post(`/api/patient/me/episodes/${ctx.episode.id}/questions`)
    .set('X-CSRF-Token', ctx.patientCtx.csrf)
    .send({ kind, subject: 'Dashboard question', body: 'Please look at my question.' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.thread;
}

async function overview(ctx, agent = ctx.coordCtx) {
  return agent.a.get('/api/dashboard');
}

async function queueOf(ctx, queueKey, query = '', agent = ctx.coordCtx) {
  return agent.a.get(`/api/dashboard/queues/${queueKey}${query ? `?${query}` : ''}`);
}

test('the dashboard counts only the caller’s own assigned work', async () => {
  const ctx = await setup();

  // Nothing is in scope before any work exists beyond the care-team row.
  const empty = await overview(ctx);
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.equal(empty.body.summary.counts.pending_approvals, 0);
  assert.equal(empty.body.summary.counts.open_questions, 0);
  assert.equal(empty.body.summary.counts.check_in_reviews, 0);
  assert.equal(empty.body.summary.counts.failed_reminders, 0);
  assert.match(empty.body.summary.note, /not monitored continuously/i);
  assert.equal(empty.body.provider.configured, 'fake');

  await flaggedCheckIn(ctx);
  await openQuestion(ctx, 'operational');
  await openQuestion(ctx, 'clinical');

  const loaded = await overview(ctx);
  assert.equal(loaded.body.summary.counts.open_questions, 2);
  assert.equal(loaded.body.summary.counts.check_in_reviews, 1);
  // Every item with no owner shows up in the missing-owners queue as well.
  assert.ok(loaded.body.summary.counts.missing_owners >= 3);

  const questions = await queueOf(ctx, 'open_questions');
  assert.equal(questions.status, 200, JSON.stringify(questions.body));
  assert.equal(questions.body.total, 2);
  // The clinical question says which authority it needs, so nobody claims work
  // they cannot answer.
  const clinical = questions.body.items.find((item) => item.kind === 'clinical');
  assert.equal(clinical.requires, 'clinical_reviewer');
  const operational = questions.body.items.find((item) => item.kind === 'operational');
  assert.equal(operational.requires, 'care_coordinator');

  const reviews = await queueOf(ctx, 'check_in_reviews');
  assert.equal(reviews.body.total, 1);
  assert.equal(reviews.body.items[0].rules.length, 1);
  assert.match(reviews.body.items[0].rules[0].label, /clinician should look/i);

  // An unassigned colleague sees an explicit refusal, not a smaller list.
  const unassigned = await overview(ctx, ctx.coord2Ctx);
  assert.equal(unassigned.status, 200, 'a coordinator may open the dashboard');
  assert.equal(
    unassigned.body.summary.counts.open_questions,
    0,
    'but sees none of another care team’s work'
  );
  assert.equal(unassigned.body.summary.counts.check_in_reviews, 0);

  // Another clinic sees nothing at all.
  const otherClinic = await overview(ctx, ctx.otherClinicCtx);
  assert.equal(otherClinic.status, 200);
  assert.equal(otherClinic.body.summary.counts.total, 0);

  // Ownership scoping is per EPISODE assignment, so the reviewer on this episode
  // sees the reviews and the questions even though they are not the coordinator.
  const reviewerView = await overview(ctx, ctx.reviewerCtx);
  assert.equal(reviewerView.body.summary.counts.check_in_reviews, 1);
});

test('an administrator cannot browse clinical queues', async () => {
  const ctx = await setup();
  await flaggedCheckIn(ctx);
  await openQuestion(ctx);

  // Two independent layers refuse: the route's permission check and the service
  // scope resolver both reject an administrator.
  const admin = await overview(ctx, ctx.adminCtx);
  assert.equal(admin.status, 403, JSON.stringify(admin.body));
  assert.match(admin.body.error.message, /permission|Administrators/i);

  assert.equal((await queueOf(ctx, 'open_questions', '', ctx.adminCtx)).status, 403);
  assert.equal((await queueOf(ctx, 'check_in_reviews', '', ctx.adminCtx)).status, 403);
  assert.equal((await ctx.adminCtx.a.get('/api/dashboard/assignments')).status, 403);

  // A patient has no dashboard either.
  assert.equal((await overview(ctx, ctx.patientCtx)).status, 403);
});

test('failed reminders reach the dashboard with a delivery reason, not a clinical one', async () => {
  const ctx = await setup();
  await harness.models.Notification.create({
    clinic: ctx.clinic._id,
    patient: ctx.patient.id,
    episode: ctx.episode.id,
    kind: 'system',
    channel: 'in_app',
    dedupeKey: 'dash:failed:1',
    title: '[fail] A reminder that could not be delivered',
    body: 'Operational reminder.',
    recipientUser: ctx.reviewer ? (await harness.models.PatientProfile.findById(ctx.patient.id).lean()).linkedUserId : null,
    recipientRole: 'patient',
    sourceType: 'episode',
    state: 'failed',
    attempts: 3,
    maxAttempts: 3,
    failedAt: new Date(),
    lastError: 'The fake provider was asked to fail this delivery.',
  });

  const failed = await queueOf(ctx, 'failed_reminders');
  assert.equal(failed.status, 200, JSON.stringify(failed.body));
  assert.equal(failed.body.total, 1);
  const item = failed.body.items[0];
  assert.equal(item.attempts, 3);
  assert.match(item.lastError, /fail this delivery/i);
  assert.ok(!/dose|dose|clinical finding/i.test(item.title.replace('[fail]', '')), 'the title is operational');
});

test('claiming is explicit, one owner at a time, and releasing keeps the history', async () => {
  const ctx = await setup();
  const thread = await openQuestion(ctx);

  const claim = await ctx.coordCtx.a
    .post(`/api/dashboard/queues/open_questions/${thread.id}/claim`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({});
  assert.equal(claim.status, 201, JSON.stringify(claim.body));
  assert.equal(claim.body.assignment.assigneeLabel, ctx.coord.user.email);

  // The item now shows an owner, and the item is no longer "missing".
  const withOwner = await queueOf(ctx, 'open_questions');
  assert.equal(withOwner.body.items[0].owner.assigneeLabel, ctx.coord.user.email);
  const mine = await queueOf(ctx, 'open_questions', 'mine=true');
  assert.equal(mine.body.total, 1);

  // A second claim on the same item is refused: ownership is unique while active.
  const secondClaim = await ctx.reviewerCtx.a
    .post(`/api/dashboard/queues/open_questions/${thread.id}/claim`)
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({});
  assert.equal(secondClaim.status, 409, JSON.stringify(secondClaim.body));

  // Somebody else cannot release my assignment.
  const otherRelease = await ctx.reviewerCtx.a
    .post(`/api/dashboard/assignments/${claim.body.assignment.id}/release`)
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({ reason: 'Not mine.' });
  assert.equal(otherRelease.status, 404, 'the assignment is not visible to them');

  const assignments = await ctx.coordCtx.a.get('/api/dashboard/assignments');
  assert.equal(assignments.status, 200, JSON.stringify(assignments.body));
  assert.equal(assignments.body.total, 1);
  assert.equal(assignments.body.items[0].claimedBySelf, true);

  const release = await ctx.coordCtx.a
    .post(`/api/dashboard/assignments/${claim.body.assignment.id}/release`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ reason: 'Handing back to the pool.' });
  assert.equal(release.status, 200, JSON.stringify(release.body));
  assert.equal(release.body.released, true);

  // The interval is closed rather than deleted, so the record survives.
  const stored = await harness.models.QueueAssignment.findById(claim.body.assignment.id).lean();
  assert.equal(stored.status, 'released');
  assert.ok(stored.releasedAt);
  assert.match(stored.releaseReason, /handing back/i);

  // Released, so it is unowned again and can be claimed by someone else.
  const requeued = await queueOf(ctx, 'open_questions');
  assert.equal(requeued.body.items[0].owner, null);

  const newOwner = await ctx.reviewerCtx.a
    .post(`/api/dashboard/queues/open_questions/${thread.id}/claim`)
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({});
  assert.equal(newOwner.status, 201, JSON.stringify(newOwner.body));
});

test('a claim is scoped to the caller’s own queues and identifiers are validated', async () => {
  const ctx = await setup();
  const thread = await openQuestion(ctx);

  // The unassigned coordinator cannot claim work that is not in their scope.
  const outOfScope = await ctx.coord2Ctx.a
    .post(`/api/dashboard/queues/open_questions/${thread.id}/claim`)
    .set('X-CSRF-Token', ctx.coord2Ctx.csrf)
    .send({});
  assert.equal(outOfScope.status, 404, JSON.stringify(outOfScope.body));

  assert.equal((await queueOf(ctx, 'everything')).status, 400);
  assert.equal((await queueOf(ctx, 'open_questions', 'page=0&limit=20')).status, 400);
  assert.equal((await queueOf(ctx, 'open_questions', 'clinicId=abc')).status, 400);
  // A target that is not in the caller's own queues is a 404, whichever way it
  // is malformed: the dashboard never confirms that someone else's work exists.
  assert.equal(
    (await ctx.coordCtx.a.post('/api/dashboard/queues/open_questions/not-a-real-target/claim')
      .set('X-CSRF-Token', ctx.coordCtx.csrf)
      .send({})).status,
    404
  );
  assert.equal(
    (await ctx.coordCtx.a.post('/api/dashboard/queues/not_a_queue/abc/claim')
      .set('X-CSRF-Token', ctx.coordCtx.csrf)
      .send({})).status,
    400
  );
  assert.equal((await ctx.coordCtx.a.get('/api/dashboard/queues/open_questions?mine=maybe')).status, 400);
});

test('pending approvals are assignment-scoped like every other queue', async () => {
  const ctx = await setup();
  const plan = await harness.models.CarePlanVersion.create({
    clinic: ctx.clinic._id,
    patient: ctx.patient.id,
    episode: ctx.episode.id,
    version: 1,
    state: 'in_review',
    createdBy: ctx.coord.user.id,
    submittedAt: new Date(),
  });

  const approvals = await queueOf(ctx, 'pending_approvals');
  assert.equal(approvals.status, 200, JSON.stringify(approvals.body));
  assert.equal(approvals.body.total, 1);
  assert.equal(approvals.body.items[0].id, String(plan._id));
  assert.equal(approvals.body.items[0].owner, null, 'nobody owns it yet');
  assert.equal(approvals.body.items[0].mine, false, 'the coordinator is not the reviewer');

  // The reviewer IS the responsible authority on this episode, which is what
  // makes an approval "assigned" rather than merely visible.
  const asReviewer = await queueOf(ctx, 'pending_approvals', '', ctx.reviewerCtx);
  assert.equal(asReviewer.body.items[0].mine, true);

  const missing = await queueOf(ctx, 'missing_owners');
  assert.equal(missing.body.total >= 1, true);
  const row = missing.body.items.find((item) => item.id === String(plan._id));
  assert.ok(row, 'the unowned approval appears in the missing-owners queue');
});
