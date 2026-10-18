'use strict';

// Part 5 care-plan gate. Runs against a replica-set MongoDB so the approval
// transaction, the revision guards and the one-current-version index are real,
// and against the real encrypted document store so "ready document only" is
// enforced by the same code the application uses.
//
// Nothing in this file enables an AI path: every clinical string is authored by
// hand by the synthetic coordinator, exactly as Part 5 requires.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const harness = require('../helpers/setup');
const { pdfDocuments, upload } = require('../helpers/documents');

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

// Two clinics: A holds the coordinator who owns the patient and episode, a
// second (unassigned) coordinator, a VERIFIED reviewer, an unverified reviewer,
// an admin, a linked patient account and a caregiver. B holds a coordinator who
// must never reach clinic A.
async function setup() {
  const a = await harness.makeClinic({ codePrefix: 'PLNA' });
  const b = await harness.makeClinic({ codePrefix: 'PLNB' });
  const ctx = { clinicA: a.clinic, clinicB: b.clinic, adminA: a.admin };

  const coord = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  ctx.coord = coord;
  ctx.coordCtx = await harness.signInStaff(app, coord.user.email);

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
    fullName: 'Synthetic Plan Patient',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ctx.patient = created.body.patient;

  const episodeRes = await ctx.coordCtx.a
    .post('/api/episodes')
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({
      patientId: ctx.patient.id,
      dischargeDate: '2026-09-28',
      dischargeTimezone: 'Europe/London',
    });
  assert.equal(episodeRes.status, 201, JSON.stringify(episodeRes.body));
  ctx.episode = episodeRes.body.episode;

  // The verified patient account that owns the profile.
  const patientUser = await harness.makeMember(a.clinic, { roleKey: 'patient' });
  await harness.models.PatientProfile.updateOne(
    { _id: ctx.patient.id },
    { $set: { linkedUserId: patientUser.user.id, status: 'active' } }
  );
  ctx.patientUser = patientUser;
  ctx.patientCtx = await harness.signInStaff(app, patientUser.user.email);

  const caregiver = await harness.makeMember(a.clinic, { roleKey: 'caregiver' });
  ctx.caregiverCtx = await harness.signInStaff(app, caregiver.user.email);

  ctx.document = await uploadPdf(ctx, 'discharge-summary.pdf');
  return ctx;
}

// Uploads a synthetic PDF through the real Part 4 intake and returns the ready
// document metadata.
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

async function readPlan(ctx, planId, agent = ctx.coordCtx) {
  const res = await agent.a.get(planPath(ctx, planId));
  return res;
}

// The plan revision is the optimistic-concurrency token for EVERY draft edit and
// transition, so each mutating helper reads it immediately before writing.
async function revisionOf(ctx, planId, agent = ctx.coordCtx) {
  const res = await readPlan(ctx, planId, agent);
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

async function linkSource(ctx, planId, itemId, body, agent = ctx.coordCtx) {
  const expectedRevision = await revisionOf(ctx, planId, agent);
  return agent.a
    .post(`${planPath(ctx, planId)}/items/${itemId}/sources`)
    .set('X-CSRF-Token', agent.csrf)
    .send({ expectedRevision, ...body });
}

async function submit(ctx, planId, agent = ctx.coordCtx) {
  const expectedRevision = await revisionOf(ctx, planId, agent);
  return agent.a
    .post(`${planPath(ctx, planId)}/submit`)
    .set('X-CSRF-Token', agent.csrf)
    .send({ expectedRevision });
}

// Reviewer helpers read the concurrency token as the COORDINATOR, so a test can
// exercise a reviewer decision (and its denial) without the reviewer's own read
// access being the thing under test.
async function clarify(ctx, planId, reason, agent = ctx.reviewerCtx) {
  const expectedRevision = await revisionOf(ctx, planId, ctx.coordCtx);
  return agent.a
    .post(`${planPath(ctx, planId)}/clarification`)
    .set('X-CSRF-Token', agent.csrf)
    .send({ expectedRevision, reason });
}

async function reviewItem(ctx, planId, itemId, decision, note) {
  const expectedRevision = await revisionOf(ctx, planId, ctx.coordCtx);
  return ctx.reviewerCtx.a
    .post(`${planPath(ctx, planId)}/items/${itemId}/review`)
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({ expectedRevision, decision, note });
}

async function approve(ctx, planId, agent = ctx.reviewerCtx) {
  const expectedRevision = await revisionOf(ctx, planId, ctx.coordCtx);
  return agent.a
    .post(`${planPath(ctx, planId)}/approve`)
    .set('X-CSRF-Token', agent.csrf)
    .send({ expectedRevision, confirm: true });
}

async function assignReviewer(ctx, target = ctx.reviewer) {
  return ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/team`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ memberUserId: target.user.id, responsibility: 'clinical_reviewer' });
}

// A complete, unambiguous medication item plus one instruction item, both cited
// to the ready document.
const COMPLETE_ITEMS = [
  {
    kind: 'medication',
    originalWording: 'Paracetamol 500 mg orally every 6 hours for 3 days as needed for pain',
    medication: 'Paracetamol',
    dose: '500 mg',
    route: 'oral',
    frequency: 'every 6 hours',
    timing: 'as needed for pain',
    duration: '3 days',
  },
  {
    kind: 'home_care',
    originalWording: 'Keep the dressing dry for 48 hours',
    homeCare: 'Keep the dressing dry and change it if it becomes loose.',
    warning: 'Contact the clinic immediately if the wound becomes hot or red.',
  },
];

// Builds, sources, submits, item-reviews and approves a plan. Returns the ids.
async function completeApproval(ctx, items = COMPLETE_ITEMS) {
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
    const res = await linkSource(ctx, planId, itemId, {
      documentId: ctx.document.id,
      text: 'Discharge medication and wound-care instructions as written above.',
      page: 1,
      location: 'Discharge summary, page 1',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }

  const reviewer = await assignReviewer(ctx);
  assert.equal(reviewer.status, 201, JSON.stringify(reviewer.body));

  const submitted = await submit(ctx, planId);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));

  for (const itemId of itemIds) {
    // eslint-disable-next-line no-await-in-loop
    const res = await reviewItem(ctx, planId, itemId, 'accepted', 'Verified against the source.');
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  return { planId, itemIds };
}

// ---------------------------------------------------------------------------
// Draft lifecycle
// ---------------------------------------------------------------------------

test('an assigned coordinator drafts a manual plan and the episode shows the plan state', async () => {
  const ctx = await setup();
  const res = await createPlan(ctx, { title: 'Manual plan', summary: 'Authored by hand.' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.plan.version, 1);
  assert.equal(res.body.plan.revision, 1);
  assert.equal(res.body.plan.state, 'draft');
  assert.equal(res.body.plan.isCurrent, false);
  assert.equal(res.body.plan.editable, true);
  assert.equal(res.body.plan.createdByLabel, ctx.coord.user.email);

  const episode = await ctx.coordCtx.a.get(`/api/episodes/${ctx.episode.id}`);
  assert.equal(episode.body.episode.planState, 'draft');
  assert.equal(episode.body.episode.approvedPlanVersion, null);
  // Approval is what activates anything; a draft never touches the episode.
  assert.equal(episode.body.episode.status, 'draft');
});

test('a medication item keeps the original wording and reports missing dose fields as unresolved', async () => {
  const ctx = await setup();
  const created = await createPlan(ctx);
  const planId = created.body.plan.id;

  const res = await addItem(ctx, planId, {
    kind: 'medication',
    originalWording: 'Metformin as directed after meals',
    medication: 'Metformin',
    frequency: 'as directed',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const item = res.body.item;
  // Verbatim preservation, never rewritten or inferred.
  assert.equal(item.originalWording, 'Metformin as directed after meals');
  assert.equal(item.dose, null);
  assert.ok(item.unresolvedFields.includes('dose'), JSON.stringify(item.unresolvedFields));
  assert.ok(item.unresolvedFields.includes('duration'));
  // "as directed" is an unclear frequency, never interpreted as a value.
  assert.ok(item.unresolvedFields.includes('frequency'));
  assert.equal(item.clinicalReviewState, 'pending');
});

test('an item with genuinely absent required fields stays unresolved and blocks approval', async () => {
  const ctx = await setup();
  const created = await createPlan(ctx);
  const planId = created.body.plan.id;
  const item = await addItem(ctx, planId, {
    kind: 'medication',
    originalWording: 'Amoxicillin 500 mg',
    medication: 'Amoxicillin',
    dose: '500 mg',
  });
  assert.equal(item.status, 201, JSON.stringify(item.body));
  assert.deepEqual(
    item.body.item.unresolvedFields.sort(),
    ['duration', 'frequency']
  );

  await linkSource(ctx, planId, item.body.item.id, {
    documentId: ctx.document.id,
    text: 'Amoxicillin 500 mg',
  });
  await assignReviewer(ctx);
  const submitted = await submit(ctx, planId);
  assert.equal(submitted.status, 200);
  const accepted = await reviewItem(ctx, planId, item.body.item.id, 'accepted');
  // The reviewer cannot wave an unresolved field through: acceptance refuses.
  assert.equal(accepted.status, 409, JSON.stringify(accepted.body));
  assert.match(accepted.body.error.message, /unresolved clinical fields/i);

  const approved = await approve(ctx, planId);
  assert.equal(approved.status, 409, JSON.stringify(approved.body));
});

test('a conflicting dose/frequency is detected and never resolved automatically', async () => {
  const ctx = await setup();
  const created = await createPlan(ctx);
  const planId = created.body.plan.id;
  const item = await addItem(ctx, planId, {
    kind: 'medication',
    originalWording: 'Ibuprofen 200 mg or 400 mg every 8 hours for 5 days',
    medication: 'Ibuprofen',
    dose: '200 mg or 400 mg',
    frequency: 'every 8 hours',
    duration: '5 days',
  });
  assert.equal(item.status, 201, JSON.stringify(item.body));
  assert.ok(
    item.body.item.unresolvedFields.includes('dose_conflict'),
    JSON.stringify(item.body.item.unresolvedFields)
  );
  // The stored value is exactly what the coordinator typed - no picking one.
  assert.equal(item.body.item.dose, '200 mg or 400 mg');

  await linkSource(ctx, planId, item.body.item.id, {
    documentId: ctx.document.id,
    text: 'Ibuprofen 200 mg or 400 mg',
  });
  await assignReviewer(ctx);
  await submit(ctx, planId);
  const approved = await approve(ctx, planId);
  assert.equal(approved.status, 409, JSON.stringify(approved.body));
  assert.match(approved.body.error.message, /unresolved clinical fields/i);
});

test('item editing, reorder and delete work on a draft and are refused on a submitted plan', async () => {
  const ctx = await setup();
  const created = await createPlan(ctx);
  const planId = created.body.plan.id;
  const first = await addItem(ctx, planId, { kind: 'instruction', originalWording: 'First instruction' });
  const second = await addItem(ctx, planId, { kind: 'instruction', originalWording: 'Second instruction' });
  assert.equal(first.body.item.order, 1);
  assert.equal(second.body.item.order, 2);

  let rev = await revisionOf(ctx, planId);
  const reordered = await ctx.coordCtx.a
    .post(`${planPath(ctx, planId)}/items/${second.body.item.id}/reorder`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ expectedRevision: rev, direction: 'up' });
  assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
  assert.deepEqual(
    reordered.body.items.map((i) => i.originalWording),
    ['Second instruction', 'First instruction']
  );

  rev = await revisionOf(ctx, planId);
  const updated = await ctx.coordCtx.a
    .patch(`${planPath(ctx, planId)}/items/${first.body.item.id}`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ expectedRevision: rev, dose: '250 mg' });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.item.dose, '250 mg');

  rev = await revisionOf(ctx, planId);
  const removed = await ctx.coordCtx.a
    .delete(`${planPath(ctx, planId)}/items/${second.body.item.id}`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ expectedRevision: rev });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.deleted, true);
  assert.equal(await harness.models.CarePlanItem.countDocuments({ version: planId }), 1);

  // Once the plan is in review the draft surface closes.
  await linkSource(ctx, planId, first.body.item.id, {
    documentId: ctx.document.id,
    text: 'First instruction',
  });
  await assignReviewer(ctx);
  assert.equal((await submit(ctx, planId)).status, 200);
  const frozen = await addItem(ctx, planId, { kind: 'instruction', originalWording: 'Too late' });
  assert.equal(frozen.status, 409, JSON.stringify(frozen.body));
});

test('a stale draft revision is refused instead of overwriting a concurrent edit', async () => {
  const ctx = await setup();
  const created = await createPlan(ctx);
  const planId = created.body.plan.id;
  await addItem(ctx, planId, { kind: 'instruction', originalWording: 'Anchor item' });
  const staleRevision = 1; // the revision the "other tab" still holds
  const stale = await ctx.coordCtx.a
    .post(`${planPath(ctx, planId)}/items`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ expectedRevision: staleRevision, kind: 'instruction', originalWording: 'Stale write' });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.match(stale.body.error.message, /out of date/i);
  assert.equal(await harness.models.CarePlanItem.countDocuments({ version: planId }), 1);

  // Two parallel writes on the SAME revision: exactly one gets through.
  const rev = await revisionOf(ctx, planId);
  const [x, y] = await Promise.all([
    ctx.coordCtx.a
      .post(`${planPath(ctx, planId)}/items`)
      .set('X-CSRF-Token', ctx.coordCtx.csrf)
      .send({ expectedRevision: rev, kind: 'instruction', originalWording: 'Racer X' }),
    ctx.coordCtx.a
      .post(`${planPath(ctx, planId)}/items`)
      .set('X-CSRF-Token', ctx.coordCtx.csrf)
      .send({ expectedRevision: rev, kind: 'instruction', originalWording: 'Racer Y' }),
  ]);
  const statuses = [x.status, y.status].sort();
  assert.deepEqual(statuses, [201, 409], JSON.stringify([x.body, y.body]));
});

// ---------------------------------------------------------------------------
// Sources and readiness
// ---------------------------------------------------------------------------

test('a source reference must point at a READY document of THIS episode', async () => {
  const ctx = await setup();
  const created = await createPlan(ctx);
  const planId = created.body.plan.id;
  const item = await addItem(ctx, planId, { kind: 'instruction', originalWording: 'Cited item' });

  // A rejected (never ready) document cannot be cited.
  const rejected = await upload(ctx.coordCtx.a, ctx.coordCtx.csrf, ctx.episode.id, {
    filename: 'encrypted.pdf',
    mediaType: 'application/pdf',
    body: pdfDocuments.withToken('/Encrypt 9 0 R'),
  });
  assert.equal(rejected.body.document.status, 'rejected');
  const notReady = await linkSource(ctx, planId, item.body.item.id, {
    documentId: rejected.body.document.id,
    text: 'Should be refused',
  });
  assert.equal(notReady.status, 409, JSON.stringify(notReady.body));
  assert.match(notReady.body.error.message, /ready document/i);

  // A document belonging to ANOTHER episode is a scoped 404, never accepted.
  const otherEpisode = await ctx.coordCtx.a
    .post('/api/episodes')
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ patientId: ctx.patient.id, dischargeDate: '2026-09-01', dischargeTimezone: 'UTC' });
  const otherDoc = await upload(ctx.coordCtx.a, ctx.coordCtx.csrf, otherEpisode.body.episode.id, {
    filename: 'other-episode.pdf',
    mediaType: 'application/pdf',
    body: pdfDocuments.valid(),
  });
  const wrongEpisode = await linkSource(ctx, planId, item.body.item.id, {
    documentId: otherDoc.body.document.id,
    text: 'Wrong episode',
  });
  assert.equal(wrongEpisode.status, 404, JSON.stringify(wrongEpisode.body));

  // A foreign document id (random ObjectId) is also a 404.
  const foreign = await linkSource(ctx, planId, item.body.item.id, {
    documentId: new mongoose.Types.ObjectId().toString(),
    text: 'Foreign',
  });
  assert.equal(foreign.status, 404);

  // The real, ready document links and appears on the item.
  const linked = await linkSource(ctx, planId, item.body.item.id, {
    documentId: ctx.document.id,
    text: 'Verbatim quotation from the discharge summary.',
    page: 2,
    location: 'Discharge summary, page 2',
  });
  assert.equal(linked.status, 201, JSON.stringify(linked.body));
  assert.equal(linked.body.source.document, ctx.document.id);
  assert.equal(linked.body.source.documentFilename, 'discharge-summary.pdf');
  assert.equal(linked.body.source.page, 2);
  // A duplicate citation of the same text is refused rather than silently added.
  const duplicate = await linkSource(ctx, planId, item.body.item.id, {
    documentId: ctx.document.id,
    text: 'Verbatim quotation from the discharge summary.',
  });
  assert.equal(duplicate.status, 409);

  const plan = await readPlan(ctx, planId);
  assert.equal(plan.body.items[0].sourceCount, 1);
  assert.equal(plan.body.items[0].sources[0].documentFilename, 'discharge-summary.pdf');
});

test('submitting requires at least one item and a source for every item', async () => {
  const ctx = await setup();
  const created = await createPlan(ctx);
  const planId = created.body.plan.id;

  const empty = await submit(ctx, planId);
  assert.equal(empty.status, 409, JSON.stringify(empty.body));
  assert.match(empty.body.error.message, /at least one item/i);

  const item = await addItem(ctx, planId, { kind: 'instruction', originalWording: 'Unsourced item' });
  const unsourced = await submit(ctx, planId);
  assert.equal(unsourced.status, 409, JSON.stringify(unsourced.body));
  assert.match(unsourced.body.error.message, /source reference/i);

  await linkSource(ctx, planId, item.body.item.id, {
    documentId: ctx.document.id,
    text: 'Sourced now',
  });
  const submitted = await submit(ctx, planId);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(submitted.body.plan.state, 'in_review');
  assert.equal(submitted.body.plan.submittedAt !== null, true);

  const episode = await ctx.coordCtx.a.get(`/api/episodes/${ctx.episode.id}`);
  assert.equal(episode.body.episode.planState, 'in_review');
});

// ---------------------------------------------------------------------------
// Authority boundaries
// ---------------------------------------------------------------------------

test('an unassigned coordinator, the admin, an unverified reviewer and another clinic are all refused', async () => {
  const ctx = await setup();
  const created = await createPlan(ctx);
  const planId = created.body.plan.id;

  // A clinic colleague who is NOT on this episode's team gets the same uniform
  // 404 as a stranger, so episode existence is never inferred from a denial.
  const colleague = await readPlan(ctx, planId, ctx.coord2Ctx);
  assert.equal(colleague.status, 404, JSON.stringify(colleague.body));
  const colleagueWrite = await createPlan(ctx, {}, ctx.coord2Ctx);
  assert.equal(colleagueWrite.status, 404);

  // Admin status never grants clinical reading or approval.
  const adminRead = await readPlan(ctx, planId, ctx.adminCtx);
  assert.equal(adminRead.status, 403, JSON.stringify(adminRead.body));
  assert.match(adminRead.body.error.message, /Administrators cannot read/i);
  const adminCreate = await createPlan(ctx, {}, ctx.adminCtx);
  assert.equal(adminCreate.status, 403);

  // An unverified reviewer cannot be assigned, and therefore cannot approve.
  const badAssign = await assignReviewer(ctx, ctx.pendingReviewer);
  assert.equal(badAssign.status, 403, JSON.stringify(badAssign.body));
  assert.match(badAssign.body.error.message, /eligibility is not currently verified/i);

  // Clinic B can never see the episode at all.
  const otherClinic = await readPlan(ctx, planId, ctx.otherClinicCtx);
  assert.equal(otherClinic.status, 404, JSON.stringify(otherClinic.body));
  const otherClinicWrite = await createPlan(ctx, {}, ctx.otherClinicCtx);
  assert.equal(otherClinicWrite.status, 404);
});

test('patients and caregivers can never see a draft or reach the version workspace', async () => {
  const ctx = await setup();
  const { planId } = await completeApproval(ctx);

  // The patient's own route exists but reveals nothing before approval, and the
  // staff workspace is closed to the patient role.
  const staffView = await readPlan(ctx, planId, ctx.patientCtx);
  assert.equal(staffView.status, 403, JSON.stringify(staffView.body));
  const history = await ctx.patientCtx.a.get(`/api/episodes/${ctx.episode.id}/plans`);
  assert.equal(history.status, 403);

  // A caregiver grant is not episode membership: the workspace answers with the
  // same scoped 404 a stranger gets, and the own-record patient route refuses the
  // caregiver role outright.
  const caregiverView = await readPlan(ctx, planId, ctx.caregiverCtx);
  assert.equal(caregiverView.status, 404, JSON.stringify(caregiverView.body));
  const caregiverPlan = await ctx.caregiverCtx.a.get(
    `/api/patient/me/episodes/${ctx.episode.id}/plan`
  );
  assert.equal(caregiverPlan.status, 403);
});

test('a revoked reviewer assignment immediately loses approval authority', async () => {
  const ctx = await setup();
  const { planId } = await completeApproval(ctx);

  const team = await ctx.coordCtx.a.get(`/api/episodes/${ctx.episode.id}/team`);
  const reviewerRow = team.body.items.find((t) => t.responsibility === 'clinical_reviewer');
  assert.ok(reviewerRow);
  const revoked = await ctx.coordCtx.a
    .delete(`/api/episodes/${ctx.episode.id}/team/${reviewerRow.id}`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));

  // The revocation removes episode membership entirely, so the reviewer loses
  // even read access (the uniform scoped 404) - not merely approval authority.
  const revokedRead = await readPlan(ctx, planId, ctx.reviewerCtx);
  assert.equal(revokedRead.status, 404, JSON.stringify(revokedRead.body));

  const rev = await revisionOf(ctx, planId, ctx.coordCtx);
  const approvedAgain = await ctx.reviewerCtx.a
    .post(`${planPath(ctx, planId)}/approve`)
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({ expectedRevision: rev, confirm: true });
  assert.equal(approvedAgain.status, 404, JSON.stringify(approvedAgain.body));

  // The plan is untouched by the failed attempt.
  const stored = await harness.models.CarePlanVersion.findById(planId).lean();
  assert.equal(stored.state, 'in_review');
  assert.equal(stored.isCurrent, false);
});

test('a coordinator cannot review, clarify or approve; a reviewer cannot draft', async () => {
  const ctx = await setup();
  const created = await createPlan(ctx);
  const planId = created.body.plan.id;
  const item = await addItem(ctx, planId, { kind: 'instruction', originalWording: 'Item' });
  await linkSource(ctx, planId, item.body.item.id, {
    documentId: ctx.document.id,
    text: 'Item',
  });
  await assignReviewer(ctx);
  await submit(ctx, planId);

  const rev = await revisionOf(ctx, planId);
  const coordApprove = await ctx.coordCtx.a
    .post(`${planPath(ctx, planId)}/approve`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ expectedRevision: rev, confirm: true });
  assert.equal(coordApprove.status, 403, JSON.stringify(coordApprove.body));

  const coordClarify = await ctx.coordCtx.a
    .post(`${planPath(ctx, planId)}/clarification`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ expectedRevision: rev, reason: 'self-review attempt' });
  assert.equal(coordClarify.status, 403);

  // The reviewer is on the team but holds no drafting permission or assignment.
  const reviewerDraft = await createPlan(ctx, {}, ctx.reviewerCtx);
  assert.equal(reviewerDraft.status, 403, JSON.stringify(reviewerDraft.body));
  const reviewerEdit = await addItem(
    ctx,
    planId,
    { kind: 'instruction', originalWording: 'nope' },
    ctx.reviewerCtx
  );
  assert.equal(reviewerEdit.status, 403);
});

test('plans of another clinic are invisible even with a guessed episode id', async () => {
  const ctx = await setup();
  const created = await createPlan(ctx);
  const planId = created.body.plan.id;

  const foreignClinic = await ctx.otherClinicCtx.a.get(
    `/api/episodes/${ctx.episode.id}/plans/${planId}`
  );
  assert.equal(foreignClinic.status, 404);
  const foreignItems = await ctx.otherClinicCtx.a.get(
    `/api/episodes/${ctx.episode.id}/plans/${planId}/items`
  );
  assert.equal(foreignItems.status, 404);

  // A well-formed but unknown plan id inside the right episode is a 404 too.
  const unknown = await ctx.coordCtx.a.get(
    `/api/episodes/${ctx.episode.id}/plans/${new mongoose.Types.ObjectId()}`
  );
  assert.equal(unknown.status, 404);
});

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

test('invalid transitions are refused with a conflict, never silently applied', async () => {
  const ctx = await setup();
  const created = await createPlan(ctx);
  const planId = created.body.plan.id;
  await assignReviewer(ctx);

  // Clarity before review: a draft cannot be clarified or approved.
  const clarifyDraft = await clarify(ctx, planId, 'too early');
  assert.equal(clarifyDraft.status, 409, JSON.stringify(clarifyDraft.body));
  const approveDraft = await approve(ctx, planId);
  assert.equal(approveDraft.status, 409, JSON.stringify(approveDraft.body));
  assert.match(approveDraft.body.error.message, /in review/i);

  const item = await addItem(ctx, planId, { kind: 'instruction', originalWording: 'Item' });
  await linkSource(ctx, planId, item.body.item.id, { documentId: ctx.document.id, text: 'Item' });
  await submit(ctx, planId);
  // A plan already in review cannot be submitted twice.
  const resubmit = await submit(ctx, planId);
  assert.equal(resubmit.status, 409, JSON.stringify(resubmit.body));

  // Clarification goes back to the coordinator, who can edit and resubmit.
  const clarified = await clarify(ctx, planId, 'Please state the exact dose of the first item.');
  assert.equal(clarified.status, 200, JSON.stringify(clarified.body));
  assert.equal(clarified.body.plan.state, 'needs_clarification');
  assert.equal(clarified.body.plan.clarificationReason, 'Please state the exact dose of the first item.');
  assert.equal(clarified.body.plan.clarificationByLabel, ctx.reviewer.user.email);
  // A clarification request is a reviewer decision, so it labels the version too.
  assert.equal(clarified.body.plan.reviewerLabel, ctx.reviewer.user.email);
  assert.ok(clarified.body.plan.reviewerAt);

  const edited = await ctx.coordCtx.a
    .patch(`${planPath(ctx, planId)}/items/${item.body.item.id}`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ expectedRevision: await revisionOf(ctx, planId), dose: '500 mg' });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));

  const resubmitted = await submit(ctx, planId);
  assert.equal(resubmitted.status, 200, JSON.stringify(resubmitted.body));
  assert.equal(resubmitted.body.plan.state, 'in_review');

  // An approved version can never be submitted, clarified or edited again.
  await reviewItem(ctx, planId, item.body.item.id, 'accepted');
  const approved = await approve(ctx, planId);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const reopen = await submit(ctx, planId);
  assert.equal(reopen.status, 409, JSON.stringify(reopen.body));
  const reClarify = await clarify(ctx, planId, 'after approval attempt');
  assert.equal(reClarify.status, 409);
});

// ---------------------------------------------------------------------------
// Approval, immutability, supersession
// ---------------------------------------------------------------------------

test('approval is one transaction: current version, episode pointer and history agree', async () => {
  const ctx = await setup();
  const { planId, itemIds } = await completeApproval(ctx);

  // Still in review: the reviewer's first item decision already labelled the
  // version, before any approval happened.
  const inReview = await readPlan(ctx, planId);
  assert.equal(inReview.body.plan.state, 'in_review');
  assert.equal(inReview.body.plan.reviewerLabel, ctx.reviewer.user.email);
  assert.equal(inReview.body.plan.approvedByLabel, null);

  const approved = await approve(ctx, planId);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.plan.state, 'approved');
  assert.equal(approved.body.plan.isCurrent, true);
  assert.equal(approved.body.plan.approvedByLabel, ctx.reviewer.user.email);
  // The version stores who REVIEWED it as well as who approved it, so a reader
  // never has to join the timeline to answer that question.
  assert.equal(approved.body.plan.reviewerLabel, ctx.reviewer.user.email);
  assert.ok(approved.body.plan.reviewerAt);
  assert.ok(approved.body.plan.approvedAt);
  assert.equal(approved.body.idempotent, false);
  assert.equal(approved.body.superseded, null);

  const episode = await ctx.coordCtx.a.get(`/api/episodes/${ctx.episode.id}`);
  assert.equal(episode.body.episode.planState, 'approved');
  assert.equal(episode.body.episode.approvedPlanVersion, planId);
  // Approval activates NOTHING downstream: the episode itself is untouched.
  assert.equal(episode.body.episode.status, 'draft');

  const events = await harness.models.ReviewEvent.find({ version: planId }).sort({ at: 1 }).lean();
  assert.deepEqual(
    events.map((e) => e.action),
    ['created', 'submitted', 'item_accepted', 'item_accepted', 'approved']
  );
  for (const event of events) {
    assert.equal(event.actorUser.toString(), event.action === 'created' || event.action === 'submitted'
      ? ctx.coord.user.id
      : ctx.reviewer.user.id);
  }
  assert.equal(itemIds.length, 2);
});

test('a repeated approval retry is idempotent instead of creating a second current version', async () => {
  const ctx = await setup();
  const { planId } = await completeApproval(ctx);
  const first = await approve(ctx, planId);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const revisionAtApproval = first.body.plan.revision;

  const retry = await ctx.reviewerCtx.a
    .post(`${planPath(ctx, planId)}/approve`)
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({ expectedRevision: revisionAtApproval - 1, confirm: true });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.idempotent, true);
  assert.equal(retry.body.plan.id, planId);

  assert.equal(
    await harness.models.CarePlanVersion.countDocuments({ episode: ctx.episode.id, isCurrent: true }),
    1
  );
  assert.equal(await harness.models.ReviewEvent.countDocuments({ version: planId, action: 'approved' }), 1);
});

test('parallel approval cannot produce two current versions', async () => {
  const ctx = await setup();
  const { planId } = await completeApproval(ctx);
  const rev = await revisionOf(ctx, planId, ctx.reviewerCtx);

  const [one, two] = await Promise.all([
    ctx.reviewerCtx.a
      .post(`${planPath(ctx, planId)}/approve`)
      .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
      .send({ expectedRevision: rev, confirm: true }),
    ctx.reviewerCtx.a
      .post(`${planPath(ctx, planId)}/approve`)
      .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
      .send({ expectedRevision: rev, confirm: true }),
  ]);

  // D-12: the invariant is "never two current versions", not a particular
  // interleaving. When the second request lands after the first commit it is
  // answered as the documented idempotent retry (200); when it lands while the
  // first is still running it is refused as stale (409). Asserting [200, 409]
  // made the test depend on scheduling; asserting the outcome does not.
  const statuses = [one.status, two.status].sort();
  for (const status of statuses) {
    assert.ok([200, 409].includes(status), JSON.stringify([one.body, two.body]));
  }
  assert.equal(statuses[0], 200, 'one approval must succeed');
  const idempotent = [one.body, two.body].filter((body) => body && body.idempotent);
  const stale = statuses.filter((status) => status === 409).length;
  assert.equal(idempotent.length + stale, 1, 'the second outcome is a retry or a stale conflict');

  assert.equal(
    await harness.models.CarePlanVersion.countDocuments({
      episode: ctx.episode.id,
      isCurrent: true,
      state: 'approved',
    }),
    1
  );
});

test('an approved version is immutable and a new draft version replaces it only after approval', async () => {
  const ctx = await setup();
  const { planId, itemIds } = await completeApproval(ctx);
  const approved = await approve(ctx, planId);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  // Every draft route refuses an approved version.
  const edit = await ctx.coordCtx.a
    .patch(`${planPath(ctx, planId)}/items/${itemIds[0]}`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ expectedRevision: approved.body.plan.revision, dose: '999 mg' });
  assert.equal(edit.status, 409, JSON.stringify(edit.body));
  const add = await addItem(ctx, planId, { kind: 'instruction', originalWording: 'should fail' });
  assert.equal(add.status, 409);
  const remove = await ctx.coordCtx.a
    .delete(`${planPath(ctx, planId)}/items/${itemIds[0]}`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ expectedRevision: approved.body.plan.revision });
  assert.equal(remove.status, 409);
  const title = await ctx.coordCtx.a
    .patch(planPath(ctx, planId))
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ expectedRevision: approved.body.plan.revision, title: 'Rewritten' });
  assert.equal(title.status, 409);
  assert.match(title.body.error.message, /immutable/i);

  const stored = await harness.models.CarePlanItem.findById(itemIds[0]).lean();
  assert.notEqual(stored.dose, '999 mg');

  // A NEW version is the only way to change anything, and the approved one stays
  // current until the replacement is approved.
  const next = await createPlan(ctx, { fromVersionId: planId, title: 'Revised plan' });
  assert.equal(next.status, 201, JSON.stringify(next.body));
  assert.equal(next.body.plan.version, 2);
  assert.equal(next.body.plan.state, 'draft');
  assert.equal(next.body.plan.isCurrent, false);

  const stillCurrent = await harness.models.CarePlanVersion.findById(planId).lean();
  assert.equal(stillCurrent.isCurrent, true);
  assert.equal(stillCurrent.state, 'approved');
  const episode = await ctx.coordCtx.a.get(`/api/episodes/${ctx.episode.id}`);
  assert.equal(episode.body.episode.approvedPlanVersion, planId);
  assert.equal(episode.body.episode.planState, 'draft');

  // Copied items start UNREVIEWED: the previous approval never carries over.
  const copied = await harness.models.CarePlanItem.find({ version: next.body.plan.id }).lean();
  assert.equal(copied.length, 2);
  for (const item of copied) assert.equal(item.clinicalReviewState, 'pending');
  for (const item of copied) assert.equal(item.reviewedBy, undefined);
  assert.equal(
    await harness.models.SourceReference.countDocuments({ version: next.body.plan.id }),
    2
  );
});

test('approving a replacement supersedes the previous version and moves the pointer', async () => {
  const ctx = await setup();
  const { planId } = await completeApproval(ctx);
  const first = await approve(ctx, planId);
  assert.equal(first.status, 200);

  const next = await createPlan(ctx, { fromVersionId: planId, title: 'Revised plan' });
  const nextId = next.body.plan.id;
  const submittedNext = await submit(ctx, nextId);
  assert.equal(submittedNext.status, 200, JSON.stringify(submittedNext.body));
  const copiedItems = await harness.models.CarePlanItem.find({ version: nextId }).lean();
  for (const item of copiedItems) {
    // eslint-disable-next-line no-await-in-loop
    const accepted = await reviewItem(ctx, nextId, item._id.toString(), 'accepted', 'Re-verified.');
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  }
  const approved = await approve(ctx, nextId);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.plan.version, 2);
  assert.equal(approved.body.plan.isCurrent, true);
  assert.equal(approved.body.superseded.id, planId);
  assert.equal(approved.body.superseded.state, 'superseded');

  const superseded = await harness.models.CarePlanVersion.findById(planId).lean();
  assert.equal(superseded.state, 'superseded');
  assert.equal(superseded.isCurrent, false);
  assert.equal(superseded.supersededBy.toString(), nextId);
  assert.equal(superseded.approvedByLabel, ctx.reviewer.user.email);

  assert.equal(
    await harness.models.CarePlanVersion.countDocuments({ episode: ctx.episode.id, isCurrent: true }),
    1
  );
  assert.equal(
    await harness.models.ReviewEvent.countDocuments({ version: planId, action: 'superseded' }),
    1
  );

  // The database itself refuses a second current version, so the invariant does
  // not depend on the service being the only writer.
  const forced = await harness.models.CarePlanVersion.updateOne(
    { _id: planId },
    { $set: { isCurrent: true, state: 'approved' } }
  ).then(
    () => null,
    (err) => err
  );
  assert.ok(forced, 'a second current approved version must be refused by the index');
  assert.equal(forced.code, 11000);

  const episode = await ctx.coordCtx.a.get(`/api/episodes/${ctx.episode.id}`);
  assert.equal(episode.body.episode.approvedPlanVersion, nextId);

  // Version history stays available to the team, newest first.
  const history = await ctx.coordCtx.a.get(`/api/episodes/${ctx.episode.id}/plans`);
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.items.map((p) => p.version), [2, 1]);
  assert.equal(history.body.items[1].supersededBy, nextId);
});

// ---------------------------------------------------------------------------
// Patient view
// ---------------------------------------------------------------------------

test('the patient sees only the current approved plan, without reviewer working state', async () => {
  const ctx = await setup();
  const { planId } = await completeApproval(ctx);

  const before = await ctx.patientCtx.a.get(`/api/patient/me/episodes/${ctx.episode.id}/plan`);
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.equal(before.body.plan, null);
  assert.deepEqual(before.body.items, []);

  const approved = await approve(ctx, planId);
  assert.equal(approved.status, 200);

  const after = await ctx.patientCtx.a.get(`/api/patient/me/episodes/${ctx.episode.id}/plan`);
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.equal(after.body.plan.id, planId);
  assert.equal(after.body.plan.approvedByLabel, ctx.reviewer.user.email);
  assert.ok(after.body.plan.approvedAt);
  assert.equal(after.body.items.length, 2);
  const med = after.body.items[0];
  assert.equal(med.originalWording, COMPLETE_ITEMS[0].originalWording);
  assert.equal(med.dose, '500 mg');
  assert.equal(med.frequency, 'every 6 hours');
  assert.equal(med.route, 'oral');
  assert.equal(med.duration, '3 days');
  assert.equal(med.sources.length, 1);
  assert.equal(med.sources[0].documentFilename, 'discharge-summary.pdf');
  assert.equal(med.sources[0].text, 'Discharge medication and wound-care instructions as written above.');
  // Internal review working state is NOT part of the patient projection.
  assert.equal(med.reviewNote, undefined);
  assert.equal(med.reviewedByLabel, undefined);
  assert.equal(med.clinicalReviewState, undefined);
  assert.equal(med.unresolvedFields, undefined);
  assert.equal(after.body.plan.clarificationReason, undefined);
  assert.equal(after.body.plan.revision, undefined);
  // The acting reviewer's identity is reviewer working state, not patient
  // content: only the approval actor/time is published.
  assert.equal(after.body.plan.reviewerLabel, undefined);
  assert.equal(after.body.plan.reviewerAt, undefined);

  // A superseded version is never what the patient reads.
  const next = await createPlan(ctx, { fromVersionId: planId });
  const nextId = next.body.plan.id;
  const submittedNext = await submit(ctx, nextId);
  assert.equal(submittedNext.status, 200, JSON.stringify(submittedNext.body));
  const copied = await harness.models.CarePlanItem.find({ version: nextId }).lean();
  for (const item of copied) {
    // eslint-disable-next-line no-await-in-loop
    const accepted = await reviewItem(ctx, nextId, item._id.toString(), 'accepted');
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  }
  const second = await approve(ctx, nextId);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const afterSecond = await ctx.patientCtx.a.get(`/api/patient/me/episodes/${ctx.episode.id}/plan`);
  assert.equal(afterSecond.body.plan.id, nextId);
  assert.equal(afterSecond.body.plan.version, 2);
});

// ---------------------------------------------------------------------------
// Safe rendering, audit redaction, no activation
// ---------------------------------------------------------------------------

test('clinical text is returned verbatim as data and never as markup', async () => {
  const ctx = await setup();
  const created = await createPlan(ctx, { title: '<b>bold</b> title' });
  const planId = created.body.plan.id;
  const hostile = '<script>alert("xss")</script> & "quoted" 5 mg';
  const item = await addItem(ctx, planId, { kind: 'instruction', originalWording: hostile });
  assert.equal(item.status, 201, JSON.stringify(item.body));
  assert.equal(item.body.item.originalWording, hostile);

  const read = await readPlan(ctx, planId);
  assert.match(read.headers['content-type'], /application\/json/);
  assert.equal(read.headers['cache-control'], 'no-store, private, max-age=0');
  assert.equal(read.body.plan.title, '<b>bold</b> title');
  assert.equal(read.body.items[0].originalWording, hostile);
  // The same string survives an edit untouched.
  const rev = await revisionOf(ctx, planId);
  const updated = await ctx.coordCtx.a
    .patch(`${planPath(ctx, planId)}/items/${item.body.item.id}`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ expectedRevision: rev, warning: '<img src=x onerror=alert(1)>' });
  assert.equal(updated.body.item.warning, '<img src=x onerror=alert(1)>');
});

test('request validation rejects unknown fields and unsafe payloads', async () => {
  const ctx = await setup();
  const created = await createPlan(ctx);
  const planId = created.body.plan.id;

  const unknown = await ctx.coordCtx.a
    .post(planPath(ctx))
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ title: 'ok', approvedBy: 'attacker' });
  assert.equal(unknown.status, 400, JSON.stringify(unknown.body));

  const noRevision = await ctx.coordCtx.a
    .post(`${planPath(ctx, planId)}/items`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ kind: 'instruction', originalWording: 'no revision' });
  assert.equal(noRevision.status, 400);

  const unconfirmed = await ctx.reviewerCtx.a
    .post(`${planPath(ctx, planId)}/approve`)
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({ expectedRevision: 1, confirm: false });
  assert.equal(unconfirmed.status, 400, JSON.stringify(unconfirmed.body));

  // Operator injection in a param is rejected before any query is built.
  const injection = await ctx.coordCtx.a.get(
    `/api/episodes/${ctx.episode.id}/plans?page[$ne]=1&limit=10`
  );
  assert.equal(injection.status, 400, JSON.stringify(injection.body));
});

test('the audit trail records the workflow without copying clinical text', async () => {
  const ctx = await setup();
  const { planId } = await completeApproval(ctx);
  const clarified = await clarify(ctx, planId, 'Please confirm the wound-care wording.');
  assert.equal(clarified.status, 200, JSON.stringify(clarified.body));
  // The wording was unchanged, so the item acceptance still stands and the plan
  // can go back into review.
  const resubmitted = await submit(ctx, planId);
  assert.equal(resubmitted.status, 200, JSON.stringify(resubmitted.body));
  const approved = await approve(ctx, planId);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  const audits = await harness.models.AuditEvent.find({ action: /^care_plan\./ }).lean();
  const actions = audits.map((a) => a.action).sort();
  assert.ok(actions.includes('care_plan.created'));
  assert.ok(actions.includes('care_plan.item_created'));
  assert.ok(actions.includes('care_plan.source_linked'));
  assert.ok(actions.includes('care_plan.submitted'));
  assert.ok(actions.includes('care_plan.approved'));

  const clinical = COMPLETE_ITEMS.map((i) => i.originalWording);
  for (const audit of audits) {
    const serialized = JSON.stringify(audit.detail || {});
    for (const text of clinical) {
      assert.equal(serialized.includes(text), false, `audit leaked clinical text: ${serialized}`);
    }
    assert.equal(serialized.includes(ctx.document.id), false);
  }

  // A review event stores the bounded human reason only, never the wording.
  const events = await harness.models.ReviewEvent.find({ action: 'clarification_requested' }).lean();
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'Please confirm the wound-care wording.');
  for (const event of events) {
    assert.equal(event.reason.length <= 500, true);
  }
  // Review history is append-only: neither update nor delete can rewrite it.
  await assert.rejects(
    () => harness.models.ReviewEvent.updateOne({ _id: events[0]._id }, { $set: { reason: 'rewritten' } })
  );
  await assert.rejects(() => harness.models.ReviewEvent.deleteOne({ _id: events[0]._id }));
});

test('approval activates no task, reminder, schedule, occurrence or log', async () => {
  const ctx = await setup();
  const { planId } = await completeApproval(ctx);
  assert.equal((await approve(ctx, planId)).status, 200);

  // Part 7 adds the schedule/task/occurrence/log models and Part 8 adds the
  // reminder/check-in/clarification/delivery models, so those collections exist
  // by construction (index build at init). The invariant approval must keep is
  // that it WRITES none of them: no schedule, task, occurrence, entry, check-in,
  // thread, message, notification, delivery attempt, queue claim or follow-up
  // may come into existence because a plan was approved.
  const downstreamModels = [
    'MedicationSchedule',
    'RecoveryTask',
    'ScheduleOccurrence',
    'ActivityLog',
    'CheckInTemplateVersion',
    'CheckInResponse',
    'ClarificationThread',
    'ClarificationMessage',
    'Notification',
    'DeliveryAttempt',
    'QueueAssignment',
    'FollowUpPlan',
  ];
  for (const name of downstreamModels) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal(
      await harness.models[name].countDocuments({}),
      0,
      `approval created a downstream document: ${name}`
    );
  }
  // Belt and braces: no collection matching the old downstream pattern holds a
  // single document either.
  const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
  for (const name of names) {
    if (!/reminder|notification|message|delivery|medication_log/i.test(name)) continue;
    // eslint-disable-next-line no-await-in-loop
    assert.equal(
      await mongoose.connection.db.collection(name).countDocuments({}),
      0,
      `unexpected downstream collection: ${name}`
    );
  }

  const episodes = await harness.models.RecoveryEpisode.find({}).lean();
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].status, 'draft');
  // Approval moves ONLY the plan pointer/state; a schedule needs a separate,
  // explicit prepare + activate by the authorized humans.
  assert.equal(episodes[0].planState, 'approved');
  assert.ok(episodes[0].approvedPlanVersion);
});

// The non-functional pass observed "GET /api/plans returned 0 items for an
// episode whose plan the same session had just created". This mirrors the perf
// driver exactly (POST an empty draft, then list with page=1&limit=1); the plan
// invariants were already covered, but not this read-after-write shape.
test('a draft created by the documented first step is listed immediately (perf observation)', async () => {
  const ctx = await setup();
  const created = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/plans`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({});
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const list = await ctx.coordCtx.a.get(
    `/api/episodes/${ctx.episode.id}/plans?page=1&limit=1`
  );
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].id, created.body.plan.id);
  assert.equal(list.body.total, 1);
});
