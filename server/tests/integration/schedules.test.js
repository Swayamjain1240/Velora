'use strict';

// Part 7 exit gate: medication schedules, recovery tasks, daily occurrences and
// actor-attributed activity logs, against a replica-set MongoDB so the
// transactions, unique indexes and concurrency guards are real.
//
// Every test states the DENIAL or boundary it relies on, not only the happy
// path: draft/unapproved sources, PRN wording, missing timing, DST edges,
// duplicate and concurrent logging, attribution for patient/caregiver/staff,
// denied caregiver scope, another clinic, a revoked grant, a stale plan version,
// version reconciliation, historical immutability and a closed episode.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const harness = require('../helpers/setup');
const { pdfDocuments, upload } = require('../helpers/documents');
const zonedTime = require('../../src/services/zonedTime');
const {
  HONOURED_CAREGIVER_SCOPES,
  CAREGIVER_SCOPES,
} = require('../../src/config/constants');

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

function zoneDate(offsetDays = 0, timezone = ZONE) {
  return zonedTime.addDays(zonedTime.todayInTimezone(timezone), offsetDays);
}

// ---- fixture ----------------------------------------------------------------

async function setup() {
  const a = await harness.makeClinic({ codePrefix: 'SCHA' });
  const b = await harness.makeClinic({ codePrefix: 'SCHB' });
  const ctx = { clinicA: a.clinic, clinicB: b.clinic, adminA: a.admin };

  const coord = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  ctx.coord = coord;
  ctx.coordCtx = await harness.signInStaff(app, coord.user.email);

  // A coordinator of the SAME clinic who is NOT assigned to this episode.
  const coord2 = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  ctx.coord2 = coord2;
  ctx.coord2Ctx = await harness.signInStaff(app, coord2.user.email);

  const reviewer = await harness.makeMember(a.clinic, {
    roleKey: 'clinical_reviewer',
    eligibility: 'verified',
  });
  ctx.reviewer = reviewer;
  ctx.reviewerCtx = await harness.signInStaff(app, reviewer.user.email);

  const pending = await harness.makeMember(a.clinic, { roleKey: 'clinical_reviewer' });
  ctx.pendingReviewer = pending;
  ctx.pendingReviewerCtx = await harness.signInStaff(app, pending.user.email);

  ctx.adminCtx = await harness.signInStaff(app, a.admin.user.email);

  const coordB = await harness.makeMember(b.clinic, { roleKey: 'care_coordinator' });
  ctx.otherClinicCtx = await harness.signInStaff(app, coordB.user.email);

  const created = await harness.createPatient(ctx.coordCtx.a, ctx.coordCtx.csrf, {
    fullName: 'Synthetic Schedule Patient',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ctx.patient = created.body.patient;

  const episodeRes = await ctx.coordCtx.a
    .post('/api/episodes')
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ patientId: ctx.patient.id, dischargeDate: '2026-09-28', dischargeTimezone: ZONE });
  assert.equal(episodeRes.status, 201, JSON.stringify(episodeRes.body));
  ctx.episode = episodeRes.body.episode;

  // The patient's own account, linked to the profile by ownership.
  const patientUser = await harness.makeMember(a.clinic, { roleKey: 'patient' });
  await harness.models.PatientProfile.updateOne(
    { _id: ctx.patient.id },
    { $set: { linkedUserId: patientUser.user.id, status: 'active' } }
  );
  ctx.patientUser = patientUser;
  ctx.patientCtx = await harness.signInStaff(app, patientUser.user.email);

  // A second clinic's patient, for cross-clinic denials.
  const otherPatient = await harness.createPatient(ctx.coordCtx.a, ctx.coordCtx.csrf, {
    fullName: 'Second Clinic Patient',
  });
  ctx.otherClinicPatient = otherPatient.body.patient;

  ctx.document = await uploadPdf(ctx, 'discharge-summary.pdf');
  return ctx;
}

async function uploadPdf(ctx, filename) {
  const res = await upload(ctx.coordCtx.a, ctx.coordCtx.csrf, ctx.episode.id, {
    filename,
    mediaType: 'application/pdf',
    body: pdfDocuments.valid(),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.document.status, 'ready');
  return res.body.document;
}

function planPath(ctx, planId) {
  return `/api/episodes/${ctx.episode.id}/plans${planId ? `/${planId}` : ''}`;
}

function schedulePath(ctx, suffix = '') {
  return `/api/episodes/${ctx.episode.id}/schedules${suffix}`;
}

async function revisionOf(ctx, planId, agent = ctx.coordCtx) {
  const res = await agent.a.get(planPath(ctx, planId));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.plan.revision;
}

async function createPlan(ctx, body = {}, agent = ctx.coordCtx) {
  return agent.a.post(planPath(ctx)).set('X-CSRF-Token', agent.csrf).send(body);
}

async function addItem(ctx, planId, fields, agent = ctx.coordCtx) {
  const expectedRevision = await revisionOf(ctx, planId, agent);
  return agent.a
    .post(`${planPath(ctx, planId)}/items`)
    .set('X-CSRF-Token', agent.csrf)
    .send({ expectedRevision, ...fields });
}

async function linkSource(ctx, planId, itemId, agent = ctx.coordCtx) {
  const expectedRevision = await revisionOf(ctx, planId, agent);
  return agent.a
    .post(`${planPath(ctx, planId)}/items/${itemId}/sources`)
    .set('X-CSRF-Token', agent.csrf)
    .send({
      expectedRevision,
      documentId: ctx.document.id,
      text: 'Discharge medication and wound-care instructions as written above.',
      page: 1,
    });
}

async function submit(ctx, planId, agent = ctx.coordCtx) {
  const expectedRevision = await revisionOf(ctx, planId, agent);
  return agent.a.post(`${planPath(ctx, planId)}/submit`).set('X-CSRF-Token', agent.csrf).send({ expectedRevision });
}

async function reviewItem(ctx, planId, itemId, decision = 'accepted', note = 'Verified against the source.') {
  const expectedRevision = await revisionOf(ctx, planId, ctx.coordCtx);
  return ctx.reviewerCtx.a
    .post(`${planPath(ctx, planId)}/items/${itemId}/review`)
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({ expectedRevision, decision, note });
}

async function approve(ctx, planId) {
  const expectedRevision = await revisionOf(ctx, planId, ctx.coordCtx);
  return ctx.reviewerCtx.a
    .post(`${planPath(ctx, planId)}/approve`)
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({ expectedRevision, confirm: true });
}

async function assignReviewer(ctx, target = ctx.reviewer) {
  return ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/team`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ memberUserId: target.user.id, responsibility: 'clinical_reviewer' });
}

// ---- item catalog -----------------------------------------------------------

// A fixed-interval medicine: three explicit daily times, five-day course.
const FIXED_MED = {
  kind: 'medication',
  originalWording: 'Amoxicillin 500 mg orally three times daily for 5 days',
  medication: 'Amoxicillin',
  dose: '500 mg',
  route: 'oral',
  frequency: 'three times daily',
  duration: '5 days',
};

// A PRN medicine whose wording also states an interval: it must NOT become an
// unconditional repeating dose.
const PRN_MED = {
  kind: 'medication',
  originalWording: 'Paracetamol 500 mg orally every 6 hours as needed for pain',
  medication: 'Paracetamol',
  dose: '500 mg',
  route: 'oral',
  frequency: 'every 6 hours',
  timing: 'as needed for pain',
  condition: 'for pain only',
  duration: '3 days',
};

// An hour interval with no anchor: the approved wording never says when the
// first dose is, so no occurrence may be invented for it.
const UNANCHORED_MED = {
  kind: 'medication',
  originalWording: 'Enoxaparin 40 mg subcutaneously every 12 hours for 7 days',
  medication: 'Enoxaparin',
  dose: '40 mg',
  route: 'subcutaneous',
  frequency: 'every 12 hours',
  duration: '7 days',
};

// A recovery task with an explicit day-part pattern.
const TASK = {
  kind: 'home_care',
  originalWording: 'Change the dressing in the morning and at night',
  homeCare: 'Keep the dressing dry; change it if it becomes loose.',
  frequency: 'twice daily',
  timing: 'morning and night',
};

// A caution: read-only plan text, never scheduled.
const WARNING = {
  kind: 'warning',
  originalWording: 'Contact the clinic immediately if the wound becomes hot or red',
  warning: 'Contact the clinic immediately if the wound becomes hot or red.',
};

// A 02:30 medicine used for the DST boundary cases.
function overnightMed(time) {
  return {
    kind: 'medication',
    originalWording: `Ramipril 5 mg orally once daily at ${time} for 30 days`,
    medication: 'Ramipril',
    dose: '5 mg',
    route: 'oral',
    frequency: 'once daily',
    timing: `at ${time}`,
    duration: '30 days',
  };
}

// Builds, sources, submits, item-reviews and approves a plan version.
async function approvePlan(ctx, items) {
  const created = await createPlan(ctx, { title: 'Post-discharge recovery', summary: 'Manual plan.' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const planId = created.body.plan.id;

  const itemIds = [];
  for (const item of items) {
    // eslint-disable-next-line no-await-in-loop
    const res = await addItem(ctx, planId, item);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    itemIds.push(res.body.item.id);
  }
  for (const itemId of itemIds) {
    // eslint-disable-next-line no-await-in-loop
    const res = await linkSource(ctx, planId, itemId);
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
  if (!ctx.reviewerAssigned) {
    const assigned = await assignReviewer(ctx);
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    ctx.reviewerAssigned = true;
  }
  const submitted = await submit(ctx, planId);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  for (const itemId of itemIds) {
    // eslint-disable-next-line no-await-in-loop
    const res = await reviewItem(ctx, planId, itemId);
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  const approved = await approve(ctx, planId);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return { planId, itemIds };
}

// ---- schedule helpers -------------------------------------------------------

async function prepare(ctx, body = {}, agent = ctx.coordCtx) {
  return agent.a
    .post(schedulePath(ctx, '/prepare'))
    .set('X-CSRF-Token', agent.csrf)
    .send({ startDate: zoneDate(-3), horizonDays: 30, ...body });
}

async function listSchedules(ctx, agent = ctx.coordCtx) {
  return agent.a.get(`${schedulePath(ctx)}?page=1&limit=20`);
}

async function occurrencesOf(ctx, scheduleId, agent = ctx.coordCtx) {
  const res = await agent.a.get(`${schedulePath(ctx, `/${scheduleId}/occurrences`)}?page=1&limit=50`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.items;
}

async function activate(ctx, scheduleId, agent = ctx.reviewerCtx, note) {
  const list = await listSchedules(ctx);
  const owner = list.body.items.find((item) => item.id === scheduleId);
  assert.ok(owner, 'the schedule must be visible to the team');
  return agent.a
    .post(schedulePath(ctx, `/${scheduleId}/activate`))
    .set('X-CSRF-Token', agent.csrf)
    .send({ expectedRevision: owner.revision, note });
}

async function today(ctx, query = {}, agent = ctx.patientCtx) {
  const params = new URLSearchParams({ tab: 'medication', page: 1, limit: 25, ...query });
  return agent.a.get(`/api/today?${params.toString()}`);
}

let requestCounter = 0;
function requestId(prefix = 'req') {
  requestCounter += 1;
  return `${prefix}-${Date.now()}-${requestCounter}-${Math.random().toString(16).slice(2, 10)}`;
}

async function recordEntry(ctx, body, agent = ctx.patientCtx) {
  return agent.a
    .post('/api/today/entries')
    .set('X-CSRF-Token', agent.csrf)
    .send({ clientRequestId: requestId(), ...body });
}

async function grantCaregiver(ctx, { email, scopes }) {
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

// ---------------------------------------------------------------------------
// Preparation only from the approved, clinician-confirmed version
// ---------------------------------------------------------------------------

test('an unapproved or draft plan version produces no schedule at all', async () => {
  const ctx = await setup();

  // No plan version exists yet.
  const none = await prepare(ctx);
  assert.equal(none.status, 409, JSON.stringify(none.body));

  // A draft exists but is not approved.
  const created = await createPlan(ctx);
  const planId = created.body.plan.id;
  const item = await addItem(ctx, planId, FIXED_MED);
  await linkSource(ctx, planId, item.body.item.id);
  const draft = await prepare(ctx);
  assert.equal(draft.status, 409, JSON.stringify(draft.body));
  assert.match(draft.body.error.message, /approved, current plan version/i);

  // Submitted for review is still not approved.
  await submit(ctx, planId);
  const inReview = await prepare(ctx);
  assert.equal(inReview.status, 409, JSON.stringify(inReview.body));

  assert.equal(await harness.models.MedicationSchedule.countDocuments({}), 0);
  assert.equal(await harness.models.RecoveryTask.countDocuments({}), 0);
  assert.equal(await harness.models.ScheduleOccurrence.countDocuments({}), 0);
});

test('preparation links every schedule to the exact approved version and item and preserves the wording', async () => {
  const ctx = await setup();
  const { planId } = await approvePlan(ctx, [FIXED_MED]);

  const res = await prepare(ctx);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const summary = res.body.summary;
  assert.equal(summary.planVersion, planId);
  assert.equal(summary.timezone, ZONE);
  assert.equal(summary.created.length, 1);
  assert.equal(summary.occurrencesCreated, 5 * 3, 'a five day course at three times daily');

  const schedule = summary.created[0];
  assert.equal(schedule.planVersion, planId);
  assert.equal(schedule.status, 'pending_activation');
  assert.equal(schedule.activationRequired, 'clinical_reviewer');
  // Verbatim clinical wording, never paraphrased or derived.
  assert.equal(schedule.dose, '500 mg');
  assert.equal(schedule.route, 'oral');
  assert.equal(schedule.frequency, 'three times daily');
  assert.equal(schedule.originalWording, FIXED_MED.originalWording);
  assert.deepEqual(schedule.timesOfDay, ['09:00', '14:00', '21:00']);
  assert.equal(schedule.endDate, zoneDate(1));
  assert.equal(schedule.patientActionable, false, 'nothing is visible before activation');

  const stored = await harness.models.MedicationSchedule.findById(schedule.id).lean();
  const plan = await harness.models.CarePlanVersion.findById(planId).lean();
  assert.equal(String(stored.planVersion), String(plan._id));
  const approvedItem = await harness.models.CarePlanItem.findOne({ version: planId }).lean();
  assert.equal(String(stored.item), String(approvedItem._id));

  // Requirement 2, field by field: every clinical field the approved item holds
  // is copied exactly - nothing paraphrased, dropped or invented - including the
  // `timing` and `condition` wording a repeating dose must never lose.
  // The schedule field names differ once (the item's `medication` is stored as
  // `medicationName`), so the mapping is stated rather than assumed.
  const VERBATIM_FIELDS = {
    medicationName: 'medication',
    dose: 'dose',
    route: 'route',
    frequency: 'frequency',
    timing: 'timing',
    condition: 'condition',
    duration: 'duration',
    originalWording: 'originalWording',
  };
  for (const [scheduleField, itemField] of Object.entries(VERBATIM_FIELDS)) {
    assert.equal(
      stored[scheduleField] ?? null,
      approvedItem[itemField] ?? null,
      `${scheduleField} must be copied verbatim from the approved item's ${itemField}`
    );
  }

  // The copy is a frozen record, not a live reference: an attempt to rewrite a
  // verbatim clinical field through the model must not take effect.
  await harness.models.MedicationSchedule.updateOne(
    { _id: stored._id },
    { $set: { dose: '999 mg', frequency: 'once daily', planVersion: plan._id } }
  );
  const unchanged = await harness.models.MedicationSchedule.findById(stored._id).lean();
  assert.equal(unchanged.dose, '500 mg', 'the approved dose cannot be rewritten');
  assert.equal(unchanged.frequency, 'three times daily');
  assert.equal(String(unchanged.planVersion), String(plan._id));

  // Occurrences are stored in UTC with the explicit zone alongside them.
  const occurrence = await harness.models.ScheduleOccurrence.findOne({ owner: stored._id }).lean();
  assert.equal(occurrence.timezone, ZONE);
  assert.equal(typeof occurrence.scheduledAtUtc.toISOString(), 'string');
  assert.equal(occurrence.localDate, zoneDate(-3));
  assert.ok(['09:00', '14:00', '21:00'].includes(occurrence.localTime));

  // A repeated preparation is idempotent rather than duplicating medication.
  const again = await prepare(ctx);
  assert.equal(again.status, 201);
  assert.equal(again.body.summary.created.length, 0);
  assert.equal(again.body.summary.updated.length, 1);
  assert.equal(await harness.models.MedicationSchedule.countDocuments({}), 1);
  assert.equal(await harness.models.ScheduleOccurrence.countDocuments({}), 15);
});

test('a PRN medicine becomes an as-needed entry that never generates a repeating dose', async () => {
  const ctx = await setup();
  await approvePlan(ctx, [PRN_MED, TASK]);
  const res = await prepare(ctx);
  assert.equal(res.status, 201, JSON.stringify(res.body));

  const conditional = res.body.summary.created.find((item) => item.type === 'medication');
  assert.equal(conditional.conditional, true);
  assert.equal(conditional.conditionalReason, 'condition');
  assert.equal(conditional.scheduleKind, 'as_needed');
  assert.deepEqual(conditional.timesOfDay, [], 'a PRN medicine gets no repeating time');

  // The PRN wording that made it conditional is preserved as written, so the
  // reason a dose is not scheduled is readable by whoever reviews it next.
  assert.equal(conditional.timing, PRN_MED.timing);
  assert.equal(conditional.condition, PRN_MED.condition);

  const task = res.body.summary.created.find((item) => item.type === 'task');
  assert.equal(task.scheduleKind, 'fixed');
  assert.deepEqual(task.timesOfDay, ['09:00', '21:00']);

  // Only the task generated occurrences. The PRN medicine generates NOTHING.
  assert.equal(await harness.models.ScheduleOccurrence.countDocuments({ ownerType: 'medication' }), 0);
  assert.ok((await harness.models.ScheduleOccurrence.countDocuments({ ownerType: 'task' })) > 0);

  // It is still a medicine, so a verified reviewer activates it before it can be
  // recorded - but with zero generated slots, ever.
  const activated = await activate(ctx, conditional.id);
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  assert.equal(activated.body.occurrencesCreated, 0);
  assert.equal(activated.body.schedule.timesOfDay.length, 0);
  assert.equal(await harness.models.ScheduleOccurrence.countDocuments({ ownerType: 'medication' }), 0);
});

test('an interval with no stated anchor stays needs_details and generates nothing', async () => {
  const ctx = await setup();
  await approvePlan(ctx, [UNANCHORED_MED]);
  const res = await prepare(ctx);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const schedule = res.body.summary.created[0];
  assert.equal(schedule.status, 'needs_details');
  assert.equal(schedule.needsDetailsReason, 'interval_without_anchor');
  assert.deepEqual(schedule.timesOfDay, []);
  assert.equal(res.body.summary.occurrencesCreated, 0);
  assert.equal(await harness.models.ScheduleOccurrence.countDocuments({}), 0);

  const blocked = await activate(ctx, schedule.id);
  assert.equal(blocked.status, 409);
});

test('a caution item is never scheduled and is reported as such', async () => {
  const ctx = await setup();
  await approvePlan(ctx, [FIXED_MED, WARNING]);
  const res = await prepare(ctx);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.summary.created.length, 1);
  assert.deepEqual(
    res.body.summary.notSchedulable.map((item) => item.kind),
    ['warning']
  );
});

// ---------------------------------------------------------------------------
// Timezone and DST boundaries
// ---------------------------------------------------------------------------

test('a medicine crossing the autumn time change keeps one slot and picks the earlier instant', async () => {
  const ctx = await setup();
  await approvePlan(ctx, [overnightMed('1:30am')]);

  const res = await prepare(ctx, {
    timezone: 'America/New_York',
    startDate: '2026-10-31',
    horizonDays: 4,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const schedule = res.body.summary.created[0];
  assert.equal(schedule.timezone, 'America/New_York');
  assert.equal(schedule.status, 'pending_activation');

  const activated = await activate(ctx, schedule.id);
  assert.equal(activated.status, 200, JSON.stringify(activated.body));

  const rows = await harness.models.ScheduleOccurrence.find({ owner: schedule.id })
    .sort({ scheduledAtUtc: 1 })
    .lean();
  const byDate = new Map(rows.map((row) => [row.localDate, row]));
  // 01:30 exists twice on 2026-11-01; the earlier instant (EDT) wins, so the
  // clock changes but the dose never moves an hour later.
  assert.equal(byDate.get('2026-10-31').scheduledAtUtc.toISOString(), '2026-10-31T05:30:00.000Z');
  assert.equal(byDate.get('2026-11-01').scheduledAtUtc.toISOString(), '2026-11-01T05:30:00.000Z');
  assert.equal(byDate.get('2026-11-01').offset, '-04:00');
  assert.equal(byDate.get('2026-11-02').scheduledAtUtc.toISOString(), '2026-11-02T06:30:00.000Z');
  assert.equal(byDate.get('2026-11-02').offset, '-05:00');
  // One slot per local day - the repeated hour never doubles a dose.
  assert.equal(rows.length, 4);
});

test('a start date outside the allowed window and an unknown timezone are refused', async () => {
  const ctx = await setup();
  await approvePlan(ctx, [FIXED_MED]);

  const badZone = await prepare(ctx, { timezone: 'Mars/Olympus' });
  assert.equal(badZone.status, 400, JSON.stringify(badZone.body));

  const farFuture = await prepare(ctx, { startDate: zoneDate(90) });
  assert.equal(farFuture.status, 400, JSON.stringify(farFuture.body));

  const badHorizon = await prepare(ctx, { horizonDays: 365 });
  assert.equal(badHorizon.status, 400, JSON.stringify(badHorizon.body));
});

// ---------------------------------------------------------------------------
// Activation authority
// ---------------------------------------------------------------------------

test('a medication schedule needs the assigned verified clinical reviewer to activate it', async () => {
  const ctx = await setup();
  await approvePlan(ctx, [FIXED_MED, TASK]);
  const prepared = await prepare(ctx);
  assert.equal(prepared.status, 201, JSON.stringify(prepared.body));
  const medication = prepared.body.summary.created.find((item) => item.type === 'medication');
  const task = prepared.body.summary.created.find((item) => item.type === 'task');

  // The coordinator may prepare but must NOT clinically activate a medicine.
  const byCoordinator = await activate(ctx, medication.id, ctx.coordCtx);
  assert.equal(byCoordinator.status, 403, JSON.stringify(byCoordinator.body));
  assert.equal(byCoordinator.body.error.code, 'FORBIDDEN');

  // A reviewer whose eligibility is not verified is refused even when an
  // assignment row exists (the Part 3 route will not create one, so the fixture
  // writes it directly to isolate the activation rule under test).
  await harness.models.CareTeamAssignment.create({
    clinic: ctx.clinicA,
    patient: ctx.patient.id,
    episode: ctx.episode.id,
    memberUser: ctx.pendingReviewer.user.id,
    responsibility: 'clinical_reviewer',
    status: 'active',
    assignedByRole: 'staff',
    assignedByUser: ctx.coord.user.id,
    assignedAt: new Date(),
  });
  const byUnverified = await activate(ctx, medication.id, ctx.pendingReviewerCtx);
  assert.equal(byUnverified.status, 403, JSON.stringify(byUnverified.body));
  assert.match(byUnverified.body.error.message, /eligibility required/i);

  // An admin is refused at the route boundary: the role carries no activation.
  const byAdmin = await activate(ctx, medication.id, ctx.adminCtx);
  assert.equal(byAdmin.status, 403);

  // An unassigned coordinator of the same clinic cannot prepare or activate. The
  // episode is a UNIFORM 404 for a non-member, so its existence is never
  // inferred from a clinical route (the Part 3/5 rule).
  const unassigned = await activate(ctx, medication.id, ctx.coord2Ctx);
  assert.equal(unassigned.status, 404, JSON.stringify(unassigned.body));
  const unassignedPrepare = await prepare(ctx, {}, ctx.coord2Ctx);
  assert.equal(unassignedPrepare.status, 404, JSON.stringify(unassignedPrepare.body));

  // Capture the revision the reviewer will retry with, so the idempotent path
  // is exercised with the SAME token (a re-read would correctly be a conflict).
  const beforeActivation = (await listSchedules(ctx)).body.items.find((item) => item.id === medication.id)
    .revision;
  const activated = await activate(ctx, medication.id, ctx.reviewerCtx, 'Activated for the documented course.');
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  assert.equal(activated.body.schedule.status, 'active');
  assert.equal(activated.body.schedule.activatedByLabel, ctx.reviewer.user.email);

  // A task is operational: the coordinator activates its own prepared task.
  const taskActivated = await activate(ctx, task.id, ctx.coordCtx);
  assert.equal(taskActivated.status, 200, JSON.stringify(taskActivated.body));
  assert.equal(taskActivated.body.schedule.status, 'active');

  // A repeat activation is an idempotent retry for the same actor and token.
  const retry = await ctx.reviewerCtx.a
    .post(schedulePath(ctx, `/${medication.id}/activate`))
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({ expectedRevision: beforeActivation });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.idempotent, true);
  assert.equal(retry.body.schedule.status, 'active');
});

test('another clinic and a non-member cannot reach schedules or the day view', async () => {
  const ctx = await setup();
  await approvePlan(ctx, [FIXED_MED]);
  const prepared = await prepare(ctx);
  const schedule = prepared.body.summary.created[0];
  await activate(ctx, schedule.id);

  const otherClinic = await ctx.otherClinicCtx.a.get(schedulePath(ctx));
  assert.equal(otherClinic.status, 404, JSON.stringify(otherClinic.body));

  const otherClinicPrepare = await ctx.otherClinicCtx.a
    .post(schedulePath(ctx, '/prepare'))
    .set('X-CSRF-Token', ctx.otherClinicCtx.csrf)
    .send({});
  assert.equal(otherClinicPrepare.status, 404);

  const byAdmin = await ctx.adminCtx.a.get(schedulePath(ctx));
  assert.equal(byAdmin.status, 403, 'admin status never grants clinical reading');
  assert.match(byAdmin.body.error.message, /Administrators cannot read/i);

  // The patient owns the day view but can never read the staff workspace.
  const patientList = await listSchedules(ctx, ctx.patientCtx);
  assert.equal(patientList.status, 403, JSON.stringify(patientList.body));

  // Staff of another clinic cannot see this patient's day.
  const foreignDay = await today(ctx, { patientId: ctx.patient.id }, ctx.otherClinicCtx);
  assert.equal(foreignDay.status, 404, JSON.stringify(foreignDay.body));
});

// ---------------------------------------------------------------------------
// Day view and states
// ---------------------------------------------------------------------------

test('the day view shows distinct recorded states and never a missed dose', async () => {
  const ctx = await setup();
  const fourTimes = {
    ...FIXED_MED,
    originalWording: 'Amoxicillin 500 mg orally four times daily for 5 days',
    frequency: 'four times daily',
  };
  await approvePlan(ctx, [fourTimes, TASK]);
  const prepared = await prepare(ctx);
  const medication = prepared.body.summary.created.find((item) => item.type === 'medication');
  const task = prepared.body.summary.created.find((item) => item.type === 'task');
  await activate(ctx, medication.id);
  await activate(ctx, task.id, ctx.coordCtx);

  const yesterDate = zoneDate(-1);
  const day = await today(ctx, { date: yesterDate });
  assert.equal(day.status, 200, JSON.stringify(day.body));
  assert.equal(day.body.date, yesterDate);
  assert.equal(day.body.timezone, ZONE);
  assert.equal(day.body.items.length, 4, 'four daily times');
  for (const item of day.body.items) {
    assert.equal(item.state, 'not_recorded');
    assert.equal(item.noEntryRecorded, true);
    assert.equal(item.clinicianVerified, false);
    assert.equal(item.actionable, true);
  }
  // The response states plainly that a missing entry is not a missed dose and
  // never carries dose advice.
  assert.equal(day.body.safety.missingEntryMeans, 'no_entry_recorded');
  assert.equal(day.body.safety.notRecordedIsNotAMissedDose, true);
  assert.equal(day.body.safety.adviceAboutExtraDose, 'none');
  assert.match(day.body.safety.note, /not a missed dose/);
  assert.doesNotMatch(JSON.stringify(day.body), /take an extra dose/i);

  // Four distinct recorded facts across the day.
  const slots = day.body.items.map((item) => item.id);
  const states = ['taken', 'skipped', 'reported_done', 'needs_help'];
  for (let index = 0; index < states.length; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await recordEntry(ctx, { occurrenceId: slots[index], entryState: states[index] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.log.entryState, states[index]);
  }

  const after = await today(ctx, { date: yesterDate });
  const byState = new Map(after.body.items.map((item) => [item.state, item]));
  for (const state of states) assert.ok(byState.has(state), `${state} must appear as its own fact`);
  assert.equal(after.body.counts.taken, 1);
  assert.equal(after.body.counts.skipped, 1);
  assert.equal(after.body.counts.reported_done, 1);
  assert.equal(after.body.counts.needs_help, 1);
  assert.equal(after.body.counts.not_recorded, 0);

  // The task tab is a separate bounded panel with its own pagination.
  const taskTab = await today(ctx, { date: yesterDate, tab: 'task' });
  assert.equal(taskTab.status, 200);
  assert.equal(taskTab.body.items.length, 2);
  assert.ok(taskTab.body.items.every((item) => item.ownerType === 'task'));

  const paged = await today(ctx, { date: yesterDate, limit: 3, page: 2 });
  assert.equal(paged.body.items.length, 1);
  assert.equal(paged.body.pages, 2);
  assert.equal(paged.body.total, 4);
});

test('an entry recorded before it is due is refused, and a future day is never actionable', async () => {
  const ctx = await setup();
  await approvePlan(ctx, [FIXED_MED]);
  const prepared = await prepare(ctx);
  const schedule = prepared.body.summary.created[0];
  await activate(ctx, schedule.id);

  const tomorrow = await today(ctx, { date: zoneDate(1) });
  assert.equal(tomorrow.status, 200);
  assert.equal(tomorrow.body.items.length, 3);
  const notDue = await recordEntry(ctx, { occurrenceId: tomorrow.body.items[0].id, entryState: 'taken' });
  assert.equal(notDue.status, 409, JSON.stringify(notDue.body));
  assert.match(notDue.body.error.message, /not due yet/i);

  // A scheduled instruction cannot be recorded without naming the occurrence.
  const scheduledWithoutTime = await recordEntry(ctx, { scheduleId: schedule.id, entryState: 'taken' });
  assert.equal(scheduledWithoutTime.status, 400, JSON.stringify(scheduledWithoutTime.body));
});

test('an as-needed entry is created only when it is recorded and never repeats', async () => {
  const ctx = await setup();
  await approvePlan(ctx, [PRN_MED, TASK]);
  const prepared = await prepare(ctx);
  const conditional = prepared.body.summary.created.find((item) => item.type === 'medication');
  const activated = await activate(ctx, conditional.id);
  assert.equal(activated.status, 200, JSON.stringify(activated.body));

  const before = await today(ctx, { date: zoneDate(-1) });
  const prnRow = before.body.items.find((item) => item.asNeeded);
  assert.ok(prnRow, 'an as-needed medicine is offered without being due');
  assert.equal(prnRow.state, 'not_recorded');
  assert.equal(prnRow.dueAtUtc, null, 'nothing is due for a conditional medicine');

  const recorded = await recordEntry(ctx, { scheduleId: conditional.id, entryState: 'taken' });
  assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
  assert.equal(recorded.body.occurrenceCreated, true);
  assert.equal(recorded.body.log.entryState, 'taken');

  const occurrence = await harness.models.ScheduleOccurrence.findById(
    recorded.body.occurrence
  ).lean();
  assert.equal(occurrence.origin, 'as_needed');
  assert.equal(occurrence.localDate, zoneDate(0));
  assert.equal(await harness.models.ScheduleOccurrence.countDocuments({ origin: 'as_needed' }), 1);

  // A future instant is still refused: this records what happened, not a plan.
  const future = await recordEntry(ctx, {
    scheduleId: conditional.id,
    entryState: 'taken',
    occurredAt: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
  });
  assert.equal(future.status, 409, JSON.stringify(future.body));

  // The recorded entry then appears on that date as a recorded fact.
  const after = await today(ctx, { date: zoneDate(0) });
  const recordedRow = after.body.items.find((item) => item.id === recorded.body.occurrence);
  assert.ok(recordedRow, 'the as-needed entry is shown on the day it happened');
  assert.equal(recordedRow.state, 'taken');
  assert.equal(recordedRow.dueAtUtc, null, 'it is never presented as due');
});

// ---------------------------------------------------------------------------
// Attribution, idempotency and corrections
// ---------------------------------------------------------------------------

test('a patient entry stores subject, actor, occurrence time and recorded-at time', async () => {
  const ctx = await setup();
  await approvePlan(ctx, [FIXED_MED]);
  const prepared = await prepare(ctx);
  const schedule = prepared.body.summary.created[0];
  await activate(ctx, schedule.id);

  const day = await today(ctx, { date: zoneDate(-1) });
  const occurrence = day.body.items[0];
  const res = await recordEntry(ctx, { occurrenceId: occurrence.id, entryState: 'taken', note: 'With breakfast.' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.log.actorRole, 'patient');
  assert.equal(res.body.log.selfReport, true, 'a patient entry is a self-report, never verification');
  assert.equal(res.body.log.actorGrant, null);
  assert.equal(new Date(res.body.log.occurrenceTimeUtc).toISOString(), new Date(occurrence.dueAtUtc).toISOString());
  assert.ok(new Date(res.body.log.recordedAtUtc) <= new Date());

  const stored = await harness.models.ActivityLog.findById(res.body.log.id).lean();
  assert.equal(String(stored.patient), String((await harness.models.PatientProfile.findOne({ linkedUserId: ctx.patientUser.user.id }).lean())._id));
  assert.equal(String(stored.actorUser), String(ctx.patientUser.user.id));
  assert.equal(stored.entryState, 'taken');
  // Bounded audit trail: no clinical text is copied into the log.
  assert.equal(/Amoxicillin/.test(JSON.stringify(res.body.log)), false);
});

test('a retried entry is idempotent and a concurrent retry still yields exactly one entry', async () => {
  const ctx = await setup();
  await approvePlan(ctx, [FIXED_MED]);
  const prepared = await prepare(ctx);
  const schedule = prepared.body.summary.created[0];
  await activate(ctx, schedule.id);
  const day = await today(ctx, { date: zoneDate(-1) });
  const occurrenceId = day.body.items[0].id;

  const clientRequestId = requestId('dupe');
  const first = await ctx.patientCtx.a
    .post('/api/today/entries')
    .set('X-CSRF-Token', ctx.patientCtx.csrf)
    .send({ occurrenceId, entryState: 'taken', clientRequestId });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const second = await ctx.patientCtx.a
    .post('/api/today/entries')
    .set('X-CSRF-Token', ctx.patientCtx.csrf)
    .send({ occurrenceId, entryState: 'taken', clientRequestId });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.idempotent, true);
  assert.equal(second.body.log.id, first.body.log.id);
  assert.equal(await harness.models.ActivityLog.countDocuments({ occurrence: occurrenceId }), 1);

  // A reused request id with a DIFFERENT fact is a conflict, not an overwrite.
  const conflicting = await ctx.patientCtx.a
    .post('/api/today/entries')
    .set('X-CSRF-Token', ctx.patientCtx.csrf)
    .send({ occurrenceId, entryState: 'skipped', clientRequestId });
  assert.equal(conflicting.status, 409, JSON.stringify(conflicting.body));

  // Two genuinely concurrent submissions of the same retry: one row, both 2xx.
  const raceId = requestId('race');
  const payload = { occurrenceId: day.body.items[1].id, entryState: 'reported_done', clientRequestId: raceId };
  const [a, b] = await Promise.all([
    ctx.patientCtx.a.post('/api/today/entries').set('X-CSRF-Token', ctx.patientCtx.csrf).send(payload),
    ctx.patientCtx.a.post('/api/today/entries').set('X-CSRF-Token', ctx.patientCtx.csrf).send(payload),
  ]);
  assert.ok([200, 201].includes(a.status), JSON.stringify(a.body));
  assert.ok([200, 201].includes(b.status), JSON.stringify(b.body));
  assert.equal(
    await harness.models.ActivityLog.countDocuments({ occurrence: day.body.items[1].id }),
    1,
    'a concurrent retry must not append a second entry'
  );

  // Two DIFFERENT entries for one occurrence: both are kept, newest is current.
  const later = await recordEntry(ctx, { occurrenceId, entryState: 'needs_help', note: 'Feeling unwell.' });
  assert.equal(later.status, 201, JSON.stringify(later.body));
  assert.equal(await harness.models.ActivityLog.countDocuments({ occurrence: occurrenceId }), 2);
  const after = await today(ctx, { date: zoneDate(-1) });
  const row = after.body.items.find((item) => item.id === occurrenceId);
  assert.equal(row.state, 'needs_help');
  assert.equal(row.corrected, false, 'a second entry is not a correction');
  assert.equal(row.entryCount, 2);
});

test('a correction appends history and never rewrites the original entry', async () => {
  const ctx = await setup();
  await approvePlan(ctx, [FIXED_MED]);
  const prepared = await prepare(ctx);
  const schedule = prepared.body.summary.created[0];
  await activate(ctx, schedule.id);
  const day = await today(ctx, { date: zoneDate(-1) });
  const occurrenceId = day.body.items[0].id;

  const original = await recordEntry(ctx, { occurrenceId, entryState: 'skipped', note: 'Not at home.' });
  assert.equal(original.status, 201, JSON.stringify(original.body));

  const correction = await recordEntry(ctx, {
    occurrenceId,
    entryState: 'taken',
    note: 'Taken later that evening.',
    correctsLogId: original.body.log.id,
    correctionReason: 'The first entry was recorded against the wrong slot.',
  });
  assert.equal(correction.status, 201, JSON.stringify(correction.body));
  assert.equal(correction.body.log.correctsLog, original.body.log.id);
  assert.equal(correction.body.log.sequence, 2);

  // The original row is byte-for-byte what it was.
  const storedOriginal = await harness.models.ActivityLog.findById(original.body.log.id).lean();
  assert.equal(storedOriginal.entryState, 'skipped');
  assert.equal(storedOriginal.note, 'Not at home.');
  assert.equal(storedOriginal.sequence, 1);
  assert.equal(
    storedOriginal.recordedAtUtc.toISOString(),
    new Date(original.body.log.recordedAtUtc).toISOString()
  );

  // The append-only guard is in the model, not merely in the service.
  await assert.rejects(
    () => harness.models.ActivityLog.updateOne({ _id: storedOriginal._id }, { $set: { entryState: 'taken' } }),
    /append-only/
  );
  await assert.rejects(
    () => harness.models.ActivityLog.deleteOne({ _id: storedOriginal._id }),
    /append-only/
  );

  const after = await today(ctx, { date: zoneDate(-1) });
  const row = after.body.items.find((item) => item.id === occurrenceId);
  assert.equal(row.state, 'taken', 'the newest entry is the current fact');
  assert.equal(row.corrected, true);
  assert.equal(row.entryCount, 2);
  assert.equal(row.entries[0].entryState, 'skipped', 'history is retained');
  assert.equal(row.entries[1].correctionReason.includes('wrong slot'), true);

  // Correcting the same entry twice is refused: only the newest may be corrected.
  const twice = await recordEntry(ctx, {
    occurrenceId,
    entryState: 'skipped',
    correctsLogId: original.body.log.id,
    correctionReason: 'Trying to correct the old row again.',
  });
  assert.equal(twice.status, 409, JSON.stringify(twice.body));

  // A correction without a reason is invalid input.
  const noReason = await recordEntry(ctx, {
    occurrenceId,
    entryState: 'taken',
    correctsLogId: correction.body.log.id,
  });
  assert.equal(noReason.status, 400, JSON.stringify(noReason.body));
});

// ---------------------------------------------------------------------------
// Caregiver scopes
// ---------------------------------------------------------------------------

test('a caregiver with view_tasks and log_tasks reads the day and records with attribution', async () => {
  const ctx = await setup();
  await approvePlan(ctx, [FIXED_MED]);
  const prepared = await prepare(ctx);
  const schedule = prepared.body.summary.created[0];
  await activate(ctx, schedule.id);

  const caregiver = await grantCaregiver(ctx, {
    email: 'sched.caregiver@synthetic.invalid',
    scopes: ['view_profile', 'view_tasks', 'log_tasks'],
  });

  const day = await today(ctx, { date: zoneDate(-1), patientId: ctx.patient.id }, caregiver);
  assert.equal(day.status, 200, JSON.stringify(day.body));
  assert.equal(day.body.access, 'caregiver');
  assert.equal(day.body.logAllowed, true);
  assert.deepEqual(day.body.caregiverScopes, ['view_profile', 'view_tasks', 'log_tasks']);

  const res = await recordEntry(
    ctx,
    { occurrenceId: day.body.items[0].id, entryState: 'taken', note: 'Given with breakfast.' },
    caregiver
  );
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.log.actorRole, 'caregiver');
  assert.equal(res.body.log.selfReport, true);
  assert.equal(res.body.log.actorGrant, caregiver.grant.id);
  const stored = await harness.models.ActivityLog.findById(res.body.log.id).lean();
  assert.equal(String(stored.actorGrant), String(caregiver.grant.id));

  // A scope that is DECLARED but not yet honoured grants nothing: granting the
  // inert document scope must not open the day view, so a future part cannot
  // assume a catalog entry is live merely because it can be granted.
  const inert = await grantCaregiver(ctx, {
    email: 'sched.inert@synthetic.invalid',
    scopes: ['view_profile', 'view_documents'],
  });
  const inertDay = await today(ctx, { date: zoneDate(-1), patientId: ctx.patient.id }, inert);
  assert.equal(inertDay.status, 404, 'an inert scope must not widen the day view');

  // The list the day view is built on is the declared one, and stays inside the
  // catalog: adding a catalog scope never silently marks it honoured.
  assert.ok(
    HONOURED_CAREGIVER_SCOPES.every((scope) => CAREGIVER_SCOPES.includes(scope)),
    'every honoured scope must exist in the catalog'
  );
  for (const scope of ['view_tasks', 'log_tasks']) {
    assert.ok(
      HONOURED_CAREGIVER_SCOPES.includes(scope),
      `${scope} is enforced by the day view, so it must be declared honoured`
    );
  }
});

test('a caregiver without log_tasks may read the day but can never record an entry', async () => {
  const ctx = await setup();
  await approvePlan(ctx, [FIXED_MED]);
  const prepared = await prepare(ctx);
  await activate(ctx, prepared.body.summary.created[0].id);

  const reader = await grantCaregiver(ctx, {
    email: 'sched.reader@synthetic.invalid',
    scopes: ['view_profile', 'view_tasks'],
  });
  const day = await today(ctx, { date: zoneDate(-1), patientId: ctx.patient.id }, reader);
  assert.equal(day.status, 200, JSON.stringify(day.body));
  assert.equal(day.body.logAllowed, false, 'the day view states it is read-only for this grant');

  const denied = await recordEntry(
    ctx,
    { occurrenceId: day.body.items[0].id, entryState: 'taken' },
    reader
  );
  assert.equal(denied.status, 404, 'no log_tasks scope -> 404, never a 403 leak');
  assert.equal(await harness.models.ActivityLog.countDocuments({}), 0);
});

test('a caregiver whose grant was revoked is refused the very next request', async () => {
  const ctx = await setup();
  await approvePlan(ctx, [FIXED_MED]);
  const prepared = await prepare(ctx);
  await activate(ctx, prepared.body.summary.created[0].id);

  const caregiver = await grantCaregiver(ctx, {
    email: 'sched.revoked@synthetic.invalid',
    scopes: ['view_tasks', 'log_tasks'],
  });
  const before = await today(ctx, { date: zoneDate(-1), patientId: ctx.patient.id }, caregiver);
  assert.equal(before.status, 200, JSON.stringify(before.body));

  const revoked = await ctx.coordCtx.a
    .delete(`/api/patients/${ctx.patient.id}/caregivers/${caregiver.grant.id}`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));

  const after = await today(ctx, { date: zoneDate(-1), patientId: ctx.patient.id }, caregiver);
  assert.equal(after.status, 404, 'revocation takes effect immediately');
  const write = await recordEntry(
    ctx,
    { occurrenceId: before.body.items[0].id, entryState: 'taken' },
    caregiver
  );
  assert.equal(write.status, 404);

  // An EXPIRED grant is treated as absent rather than as a downgraded grant, so
  // it opens neither the day view nor an entry - the same uniform 404.
  const expiring = await grantCaregiver(ctx, {
    email: 'sched.expired@synthetic.invalid',
    scopes: ['view_tasks', 'log_tasks'],
  });
  const open = await today(ctx, { date: zoneDate(-1), patientId: ctx.patient.id }, expiring);
  assert.equal(open.status, 200, JSON.stringify(open.body));
  await harness.models.CaregiverGrant.updateOne(
    { _id: expiring.grant.id },
    { $set: { expiresAt: new Date(Date.now() - 60_000) } }
  );
  const expiredRead = await today(ctx, { date: zoneDate(-1), patientId: ctx.patient.id }, expiring);
  assert.equal(expiredRead.status, 404, 'an expired grant grants nothing');
  const expiredWrite = await recordEntry(
    ctx,
    { occurrenceId: open.body.items[0].id, entryState: 'taken' },
    expiring
  );
  assert.equal(expiredWrite.status, 404);
});

test('staff may record on the patient behalf and the entry is attributed to them', async () => {
  const ctx = await setup();
  await approvePlan(ctx, [FIXED_MED]);
  const prepared = await prepare(ctx);
  await activate(ctx, prepared.body.summary.created[0].id);

  const day = await today(ctx, { date: zoneDate(-1), patientId: ctx.patient.id }, ctx.coordCtx);
  assert.equal(day.status, 200, JSON.stringify(day.body));
  assert.equal(day.body.access, 'team');

  const res = await recordEntry(
    ctx,
    { occurrenceId: day.body.items[0].id, entryState: 'reported_done', note: 'Recorded from the ward round.' },
    ctx.coordCtx
  );
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.log.actorRole, 'care_coordinator');
  assert.equal(res.body.log.selfReport, false, 'a staff entry is not a patient self-report');
});

test('an unassigned staff member cannot read or record even with a care-team role', async () => {
  const ctx = await setup();
  await approvePlan(ctx, [FIXED_MED]);
  const prepared = await prepare(ctx);
  await activate(ctx, prepared.body.summary.created[0].id);

  const day = await today(ctx, { date: zoneDate(-1), patientId: ctx.patient.id }, ctx.coord2Ctx);
  assert.equal(day.status, 403, JSON.stringify(day.body));
  assert.match(day.body.error.message, /not assigned/i);
});

// ---------------------------------------------------------------------------
// Version reconciliation
// ---------------------------------------------------------------------------

test('a new approved version supersedes future occurrences and preserves the recorded past', async () => {
  const ctx = await setup();
  const v1 = await approvePlan(ctx, [FIXED_MED, TASK]);
  const preparedV1 = await prepare(ctx);
  const medicationV1 = preparedV1.body.summary.created.find((item) => item.type === 'medication');
  const taskV1 = preparedV1.body.summary.created.find((item) => item.type === 'task');
  await activate(ctx, medicationV1.id);
  await activate(ctx, taskV1.id, ctx.coordCtx);

  // Record a fact against a PAST occurrence of v1.
  const pastDate = zoneDate(-2);
  const pastDay = await today(ctx, { date: pastDate });
  const pastOccurrence = pastDay.body.items[0];
  const pastEntry = await recordEntry(ctx, { occurrenceId: pastOccurrence.id, entryState: 'taken' });
  assert.equal(pastEntry.status, 201, JSON.stringify(pastEntry.body));

  // A new version changes the medicine that will generate the schedule.
  const v2Item = {
    kind: 'medication',
    originalWording: 'Amoxicillin 250 mg orally twice daily for 5 days',
    medication: 'Amoxicillin',
    dose: '250 mg',
    route: 'oral',
    frequency: 'twice daily',
    duration: '5 days',
  };
  const v2 = await approvePlan(ctx, [v2Item, TASK]);

  const reconciled = await prepare(ctx);
  assert.equal(reconciled.status, 201, JSON.stringify(reconciled.body));
  const summary = reconciled.body.summary;
  assert.equal(summary.planVersion, v2.planId);
  assert.equal(summary.superseded.length, 2, 'both v1 owners are superseded');
  assert.equal(summary.created.length, 2, 'only the new version produces new owners');
  assert.ok(summary.occurrencesSuperseded > 0);

  // v1 owners are superseded and point at their verbatim replacement where the
  // wording is unchanged (the task), and nowhere where it changed (the medicine).
  const v1Medication = await harness.models.MedicationSchedule.findById(medicationV1.id).lean();
  assert.equal(v1Medication.status, 'superseded');
  assert.equal(v1Medication.supersededAt instanceof Date, true);
  const v1Task = await harness.models.RecoveryTask.findById(taskV1.id).lean();
  assert.equal(v1Task.status, 'superseded');
  assert.ok(v1Task.supersededBy, 'the unchanged task points at its replacement');

  // Future v1 occurrences are superseded; the past one is untouched, along with
  // its log.
  const futureV1 = await harness.models.ScheduleOccurrence.countDocuments({
    owner: { $in: [medicationV1.id, taskV1.id] },
    status: 'superseded',
  });
  assert.ok(futureV1 > 0);
  const pastRow = await harness.models.ScheduleOccurrence.findById(pastOccurrence.id).lean();
  assert.equal(pastRow.status, 'scheduled', 'a historical occurrence keeps its status');
  const pastLog = await harness.models.ActivityLog.findById(pastEntry.body.log.id).lean();
  assert.equal(pastLog.entryState, 'taken');
  assert.equal(pastLog.occurrenceTimeUtc.toISOString(), new Date(pastOccurrence.dueAtUtc).toISOString());

  // The shared wording (the task) is carried across versions, but EVERY new
  // occurrence belongs to the new version only.
  const newOccurrences = await harness.models.ScheduleOccurrence.find({
    planVersion: v2.planId,
  }).lean();
  assert.ok(newOccurrences.length > 0);
  assert.ok(newOccurrences.every((row) => String(row.planVersion) === String(v2.planId)));

  // The day view for the old date still shows the recorded fact, flagged as
  // historical and no longer actionable, and never rewritten.
  const historical = await today(ctx, { date: pastDate });
  assert.equal(historical.status, 200, JSON.stringify(historical.body));
  const row = historical.body.items.find((item) => item.id === pastOccurrence.id);
  assert.ok(row, 'the recorded past stays visible after reconciliation');
  assert.equal(row.state, 'taken');
  assert.equal(row.historical, true);
  assert.equal(row.actionable, false);
  assert.equal(historical.body.items.filter((item) => item.id === pastOccurrence.id).length, 1);
  // Recording against a superseded occurrence is refused.
  const refused = await recordEntry(ctx, { occurrenceId: pastOccurrence.id, entryState: 'skipped' });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));

  // The superseded schedule can no longer be activated.
  const staleActivation = await activate(ctx, medicationV1.id);
  assert.equal(staleActivation.status, 409, JSON.stringify(staleActivation.body));

  void v1;
});

test('activating a schedule whose plan version was superseded is refused', async () => {
  const ctx = await setup();
  await approvePlan(ctx, [FIXED_MED]);
  const prepared = await prepare(ctx);
  const schedule = prepared.body.summary.created[0];

  // A new version is approved while the first schedule is still prepared.
  await approvePlan(ctx, [FIXED_MED]);

  const blocked = await activate(ctx, schedule.id);
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.match(blocked.body.error.message, /superseded plan version/i);
});

// ---------------------------------------------------------------------------
// Closed episode and input validation
// ---------------------------------------------------------------------------

test('a closed episode stops new activity but keeps the history readable', async () => {
  const ctx = await setup();
  await approvePlan(ctx, [FIXED_MED]);
  const prepared = await prepare(ctx);
  const schedule = prepared.body.summary.created[0];
  await activate(ctx, schedule.id);

  const day = await today(ctx, { date: zoneDate(-1) });
  const occurrence = day.body.items[0];
  const recorded = await recordEntry(ctx, { occurrenceId: occurrence.id, entryState: 'taken' });
  assert.equal(recorded.status, 201);

  await harness.models.RecoveryEpisode.updateOne(
    { _id: ctx.episode.id },
    { $set: { status: 'closed' } }
  );

  const blockedPrepare = await prepare(ctx);
  assert.equal(blockedPrepare.status, 409, JSON.stringify(blockedPrepare.body));
  assert.match(blockedPrepare.body.error.message, /closed/i);

  const blockedEntry = await recordEntry(ctx, { occurrenceId: occurrence.id, entryState: 'skipped' });
  assert.equal(blockedEntry.status, 409, JSON.stringify(blockedEntry.body));
  assert.match(blockedEntry.body.error.message, /closed and read-only/i);

  // History stays readable: the recorded fact and the schedule are still there.
  const readOnly = await today(ctx, { date: zoneDate(-1), episodeId: ctx.episode.id });
  assert.equal(readOnly.status, 200, JSON.stringify(readOnly.body));
  assert.equal(readOnly.body.episode.readOnly, true);
  const row = readOnly.body.items.find((item) => item.id === occurrence.id);
  assert.equal(row.state, 'taken');
  assert.equal(await harness.models.ActivityLog.countDocuments({ occurrence: occurrence.id }), 1);
});

test('invalid identifiers, enums and instants are rejected before any write', async () => {
  const ctx = await setup();
  await approvePlan(ctx, [FIXED_MED]);
  const prepared = await prepare(ctx);
  await activate(ctx, prepared.body.summary.created[0].id);
  const day = await today(ctx, { date: zoneDate(-1) });
  const occurrenceId = day.body.items[0].id;

  const badState = await recordEntry(ctx, { occurrenceId, entryState: 'double_dose' });
  assert.equal(badState.status, 400, JSON.stringify(badState.body));

  const both = await recordEntry(ctx, {
    occurrenceId,
    scheduleId: prepared.body.summary.created[0].id,
    entryState: 'taken',
  });
  assert.equal(both.status, 400);

  const noRequestId = await ctx.patientCtx.a
    .post('/api/today/entries')
    .set('X-CSRF-Token', ctx.patientCtx.csrf)
    .send({ occurrenceId, entryState: 'taken' });
  assert.equal(noRequestId.status, 400);

  const badOccurrence = await recordEntry(ctx, { occurrenceId: 'not-an-object-id', entryState: 'taken' });
  assert.equal(badOccurrence.status, 400);

  const unknownOccurrence = await recordEntry(ctx, {
    occurrenceId: '0123456789abcdef01234567',
    entryState: 'taken',
  });
  assert.equal(unknownOccurrence.status, 404);

  const badDate = await today(ctx, { date: '31-10-2026' });
  assert.equal(badDate.status, 400);
  const badZone = await today(ctx, { timezone: 'Nowhere/Special' });
  assert.equal(badZone.status, 400);
  const badTab = await today(ctx, { tab: 'everything' });
  assert.equal(badTab.status, 400);

  // Nothing was written by any refused request.
  assert.equal(await harness.models.ActivityLog.countDocuments({}), 0);
});

test('the team reads an attributed, paginated activity history for the episode', async () => {
  const ctx = await setup();
  await approvePlan(ctx, [FIXED_MED]);
  const prepared = await prepare(ctx);
  await activate(ctx, prepared.body.summary.created[0].id);
  const day = await today(ctx, { date: zoneDate(-1) });
  await recordEntry(ctx, { occurrenceId: day.body.items[0].id, entryState: 'taken' });
  await recordEntry(ctx, { occurrenceId: day.body.items[1].id, entryState: 'skipped' });

  const res = await ctx.coordCtx.a.get(`/api/episodes/${ctx.episode.id}/activity-logs?page=1&limit=1`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.total, 2);
  assert.equal(res.body.items[0].selfReport, true);
  assert.ok(res.body.items[0].actorLabel);

  const denied = await ctx.otherClinicCtx.a.get(`/api/episodes/${ctx.episode.id}/activity-logs`);
  assert.equal(denied.status, 404);
});
