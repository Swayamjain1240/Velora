'use strict';

// Part 6 language gate: reviewed Hindi/English renderings of plan instructions.
//
// A rendering must stay linked to the instruction it renders, be versioned,
// preserve meaning, be approved by an ASSIGNED VERIFIED clinical reviewer, and
// never become patient-visible automatically.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const harness = require('../helpers/setup');
const { pdfDocuments, upload } = require('../helpers/documents');
const languageVariants = require('../../src/services/languageVariantService');

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

async function setup() {
  const a = await harness.makeClinic({ codePrefix: 'LVA' });
  const ctx = {};

  ctx.coord = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  ctx.coordCtx = await harness.signInStaff(app, ctx.coord.user.email);
  ctx.reviewer = await harness.makeMember(a.clinic, {
    roleKey: 'clinical_reviewer',
    eligibility: 'verified',
  });
  ctx.reviewerCtx = await harness.signInStaff(app, ctx.reviewer.user.email);
  const pending = await harness.makeMember(a.clinic, { roleKey: 'clinical_reviewer' });
  ctx.pendingCtx = await harness.signInStaff(app, pending.user.email);
  ctx.adminCtx = await harness.signInStaff(app, a.admin.user.email);

  const created = await harness.createPatient(ctx.coordCtx.a, ctx.coordCtx.csrf, {
    fullName: 'Synthetic Language Patient',
  });
  ctx.patient = created.body.patient;
  const episodeRes = await ctx.coordCtx.a
    .post('/api/episodes')
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({
      patientId: ctx.patient.id,
      dischargeDate: '2026-09-28',
      dischargeTimezone: 'Europe/London',
    });
  ctx.episode = episodeRes.body.episode;
  await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/team`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ memberUserId: ctx.reviewer.user.id, responsibility: 'clinical_reviewer' });

  const patientUser = await harness.makeMember(a.clinic, { roleKey: 'patient' });
  await harness.models.PatientProfile.updateOne(
    { _id: ctx.patient.id },
    { $set: { linkedUserId: patientUser.user.id, status: 'active' } }
  );
  ctx.patientCtx = await harness.signInStaff(app, patientUser.user.email);

  const uploadRes = await upload(ctx.coordCtx.a, ctx.coordCtx.csrf, ctx.episode.id, {
    filename: 'synthetic-discharge-note.pdf',
    mediaType: 'application/pdf',
    body: pdfDocuments.dischargeNote(),
  });
  ctx.document = uploadRes.body.document;

  const planRes = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/plans`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ title: 'Language draft' });
  ctx.plan = planRes.body.plan;

  const itemRes = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/plans/${ctx.plan.id}/items`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({
      expectedRevision: 1,
      kind: 'medication',
      originalWording: 'Paracetamol 500 mg orally every 6 hours for 3 days',
      medication: 'Paracetamol',
      dose: '500 mg',
      route: 'oral',
      frequency: 'every 6 hours',
      duration: '3 days',
    });
  assert.equal(itemRes.status, 201, JSON.stringify(itemRes.body));
  ctx.item = itemRes.body.item;
  return ctx;
}

function variantsPath(ctx, suffix = '') {
  return `/api/episodes/${ctx.episode.id}/plans/${ctx.plan.id}/variants${suffix}`;
}

function createVariant(ctx, body, agent = ctx.coordCtx) {
  return agent.a
    .post(`/api/episodes/${ctx.episode.id}/plans/${ctx.plan.id}/items/${ctx.item.id}/variants`)
    .set('X-CSRF-Token', agent.csrf)
    .send(body);
}

const HINDI = '\u092a\u0948\u0930\u093e\u0938\u093f\u091f\u093e\u092e\u0949\u0932 500 mg \u092e\u0941\u0902\u0939 \u0938\u0947 \u0939\u0930 6 \u0918\u0902\u091f\u0947 \u092e\u0947\u0902, 3 \u0926\u093f\u0928 \u0924\u0915';

test('a Hindi rendering stays linked to its instruction, is versioned and needs reviewer approval', async () => {
  const ctx = await setup();
  const created = await createVariant(ctx, { language: 'hi', kind: 'translation', text: HINDI });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const variant = created.body.variant;
  assert.equal(variant.language, 'hi');
  assert.equal(variant.variant, 1);
  assert.equal(variant.reviewState, 'draft');
  // The instruction it renders is captured with it, verbatim.
  assert.equal(variant.sourceWording, ctx.item.originalWording);
  assert.equal(variant.fidelity.checked, true);
  assert.equal(variant.fidelity.passed, true);
  assert.equal(variant.producedBy, 'human');

  const submitted = await ctx.coordCtx.a
    .post(variantsPath(ctx, `/${variant.id}/submit`))
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(submitted.body.variant.reviewState, 'in_review');

  // Reviewing is a clinical decision: the coordinator and the admin are refused,
  // and so is an unverified reviewer.
  const byCoord = await ctx.coordCtx.a
    .post(variantsPath(ctx, `/${variant.id}/approve`))
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ fidelityNote: 'Meaning preserved.' });
  assert.equal(byCoord.status, 403);
  const byAdmin = await ctx.adminCtx.a
    .post(variantsPath(ctx, `/${variant.id}/approve`))
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({ fidelityNote: 'Meaning preserved.' });
  assert.equal(byAdmin.status, 403);
  const byPending = await ctx.pendingCtx.a
    .post(variantsPath(ctx, `/${variant.id}/approve`))
    .set('X-CSRF-Token', ctx.pendingCtx.csrf)
    .send({ fidelityNote: 'Meaning preserved.' });
  assert.equal(byPending.status, 403);

  // Approval requires the reviewer to state that the meaning is preserved.
  const noNote = await ctx.reviewerCtx.a
    .post(variantsPath(ctx, `/${variant.id}/approve`))
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({});
  assert.equal(noNote.status, 400, JSON.stringify(noNote.body));

  const approved = await ctx.reviewerCtx.a
    .post(variantsPath(ctx, `/${variant.id}/approve`))
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({ fidelityNote: 'Reviewed against the source instruction; meaning preserved.' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.variant.reviewState, 'approved');
  assert.equal(approved.body.variant.approvedByLabel, ctx.reviewer.user.email);
  assert.ok(approved.body.variant.approvedAt);

  // Approving a rendering changes NO clinical state: the item and the version are
  // untouched, and the plan is still a draft.
  const item = await harness.models.CarePlanItem.findById(ctx.item.id).lean();
  assert.equal(item.clinicalReviewState, 'pending');
  assert.equal(item.dose, '500 mg');
  const version = await harness.models.CarePlanVersion.findById(ctx.plan.id).lean();
  assert.equal(version.state, 'draft');
  assert.equal(version.isCurrent, false);
});

test('a rendering that drops a stated number can never be approved', async () => {
  const ctx = await setup();
  const lossy = await createVariant(ctx, {
    language: 'en',
    kind: 'simplification',
    text: 'Take the tablet with water regularly for a few days',
  });
  assert.equal(lossy.status, 201, JSON.stringify(lossy.body));
  assert.equal(lossy.body.variant.fidelity.passed, false);
  assert.ok(lossy.body.variant.fidelity.warnings.includes('missing_number_in_dose'));

  await ctx.coordCtx.a
    .post(variantsPath(ctx, `/${lossy.body.variant.id}/submit`))
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({});
  const refused = await ctx.reviewerCtx.a
    .post(variantsPath(ctx, `/${lossy.body.variant.id}/approve`))
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({ fidelityNote: 'Meaning preserved.' });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error.message, /preserve/i);

  // A faithful English simplification of the same instruction IS approvable.
  const faithful = await createVariant(ctx, {
    language: 'en',
    kind: 'simplification',
    text: 'Paracetamol 500 mg by mouth every 6 hours for 3 days',
  });
  assert.equal(faithful.body.variant.fidelity.passed, true);
  // A revision is a NEW variant: the lossy draft above was version 1, so a
  // corrected rendering of the same (item, language, kind) is version 2.
  assert.equal(faithful.body.variant.variant, 2);
  await ctx.coordCtx.a
    .post(variantsPath(ctx, `/${faithful.body.variant.id}/submit`))
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({});
  const ok = await ctx.reviewerCtx.a
    .post(variantsPath(ctx, `/${faithful.body.variant.id}/approve`))
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({ fidelityNote: 'Same dose, route, frequency and duration. Meaning preserved.' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('a new rendering is a new version, and approving it supersedes the previous one', async () => {
  const ctx = await setup();
  const first = await createVariant(ctx, { language: 'hi', kind: 'translation', text: HINDI });
  await ctx.coordCtx.a
    .post(variantsPath(ctx, `/${first.body.variant.id}/submit`))
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({});
  await ctx.reviewerCtx.a
    .post(variantsPath(ctx, `/${first.body.variant.id}/approve`))
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({ fidelityNote: 'Meaning preserved.' });

  const second = await createVariant(ctx, {
    language: 'hi',
    kind: 'translation',
    text: `${HINDI} (\u0938\u0902\u0936\u094b\u0927\u093f\u0924)`,
  });
  assert.equal(second.body.variant.variant, 2);
  await ctx.coordCtx.a
    .post(variantsPath(ctx, `/${second.body.variant.id}/submit`))
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({});
  const approved = await ctx.reviewerCtx.a
    .post(variantsPath(ctx, `/${second.body.variant.id}/approve`))
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({ fidelityNote: 'Corrected rendering; meaning preserved.' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.superseded.variant, 1);

  const stored = await harness.models.ReviewedLanguageVariant.find({ item: ctx.item.id }).lean();
  const approvedOnes = stored.filter((row) => row.reviewState === 'approved');
  assert.equal(approvedOnes.length, 1);
  assert.equal(approvedOnes[0].variant, 2);
  const superseded = stored.find((row) => row.variant === 1);
  assert.equal(superseded.reviewState, 'superseded');
});

test('approving is refused when the instruction changed after the rendering was drafted', async () => {
  const ctx = await setup();
  const variant = await createVariant(ctx, { language: 'hi', kind: 'translation', text: HINDI });
  await ctx.coordCtx.a
    .post(variantsPath(ctx, `/${variant.body.variant.id}/submit`))
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({});

  // The coordinator edits the instruction: the rendering no longer renders it.
  const revision = (await harness.models.CarePlanVersion.findById(ctx.plan.id).lean()).revision;
  const edited = await ctx.coordCtx.a
    .patch(`/api/episodes/${ctx.episode.id}/plans/${ctx.plan.id}/items/${ctx.item.id}`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ expectedRevision: revision, dose: '1000 mg' });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));

  const refused = await ctx.reviewerCtx.a
    .post(variantsPath(ctx, `/${variant.body.variant.id}/approve`))
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({ fidelityNote: 'Meaning preserved.' });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error.message, /changed after/i);
});

test('a reviewer can reject a rendering and the coordinator can draft another', async () => {
  const ctx = await setup();
  const variant = await createVariant(ctx, { language: 'hi', kind: 'translation', text: HINDI });
  await ctx.coordCtx.a
    .post(variantsPath(ctx, `/${variant.body.variant.id}/submit`))
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({});
  const rejected = await ctx.reviewerCtx.a
    .post(variantsPath(ctx, `/${variant.body.variant.id}/reject`))
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({ reason: 'The wording is ambiguous in Hindi.' });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.equal(rejected.body.variant.reviewState, 'draft');
  assert.equal(rejected.body.variant.rejectionReason, 'The wording is ambiguous in Hindi.');
});

test('renderings are team-only, scoped to the clinic, and never patient-visible', async () => {
  const ctx = await setup();
  const variant = await createVariant(ctx, { language: 'hi', kind: 'translation', text: HINDI });
  await ctx.coordCtx.a
    .post(variantsPath(ctx, `/${variant.body.variant.id}/submit`))
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({});
  await ctx.reviewerCtx.a
    .post(variantsPath(ctx, `/${variant.body.variant.id}/approve`))
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({ fidelityNote: 'Meaning preserved.' });

  const teamRead = await ctx.reviewerCtx.a.get(variantsPath(ctx, '?page=1&limit=10'));
  assert.equal(teamRead.status, 200, JSON.stringify(teamRead.body));
  assert.equal(teamRead.body.items.length, 1);
  assert.equal(teamRead.body.items[0].itemOrder, 1);
  assert.equal(teamRead.body.items[0].clinicalValues.dose, '500 mg');

  const patientRead = await ctx.patientCtx.a.get(variantsPath(ctx, '?page=1&limit=10'));
  assert.ok([403, 404].includes(patientRead.status), JSON.stringify(patientRead.body));

  // Complete the plan so the patient has an approved plan to read, then assert
  // that the approved projection contains NO rendering and NO Hindi text.
  const revision = (await harness.models.CarePlanVersion.findById(ctx.plan.id).lean()).revision;
  await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/plans/${ctx.plan.id}/items/${ctx.item.id}/sources`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({
      expectedRevision: revision,
      documentId: ctx.document.id,
      text: 'Medication: Paracetamol 500 mg orally every 6 hours for 3 days',
      page: 1,
    });
  await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/plans/${ctx.plan.id}/submit`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ expectedRevision: (await harness.models.CarePlanVersion.findById(ctx.plan.id).lean()).revision });
  await ctx.reviewerCtx.a
    .post(`/api/episodes/${ctx.episode.id}/plans/${ctx.plan.id}/items/${ctx.item.id}/review`)
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({
      expectedRevision: (await harness.models.CarePlanVersion.findById(ctx.plan.id).lean()).revision,
      decision: 'accepted',
    });
  const approvedPlan = await ctx.reviewerCtx.a
    .post(`/api/episodes/${ctx.episode.id}/plans/${ctx.plan.id}/approve`)
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({
      expectedRevision: (await harness.models.CarePlanVersion.findById(ctx.plan.id).lean()).revision,
      confirm: true,
    });
  assert.equal(approvedPlan.status, 200, JSON.stringify(approvedPlan.body));

  const patientPlan = await ctx.patientCtx.a.get(`/api/patient/me/episodes/${ctx.episode.id}/plan`);
  assert.equal(patientPlan.status, 200, JSON.stringify(patientPlan.body));
  assert.equal(patientPlan.body.plan.id, ctx.plan.id);
  const serialized = JSON.stringify(patientPlan.body);
  assert.equal(serialized.includes('\u092a\u0948\u0930\u093e\u0938\u093f\u091f\u093e\u092e\u0949\u0932'), false);
  // No rendered wording and no variant metadata leaks into the patient
  // projection: an approved rendering is never patient-visible on its own
  // (Part 6 language rule). `kind` and the source `text` are legitimate
  // approved-plan fields, so only variant-specific keys are asserted here.
  assert.equal(
    /"(language|variant|sourceWording|sourceFingerprint|producedBy|fidelityNote)"\s*:/i.test(serialized),
    false
  );
});

test('the audit trail records the language workflow without the rendered wording', async () => {
  const ctx = await setup();
  const variant = await createVariant(ctx, { language: 'hi', kind: 'translation', text: HINDI });
  await ctx.coordCtx.a
    .post(variantsPath(ctx, `/${variant.body.variant.id}/submit`))
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({});
  await ctx.reviewerCtx.a
    .post(variantsPath(ctx, `/${variant.body.variant.id}/approve`))
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({ fidelityNote: 'Meaning preserved.' });

  const events = await harness.models.AuditEvent.find({ action: { $regex: '^language\\.' } }).lean();
  assert.deepEqual(
    events.map((event) => event.action).sort(),
    ['language.variant_approved', 'language.variant_created', 'language.variant_submitted']
  );
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes('\u092a\u0948\u0930\u093e\u0938\u093f\u091f\u093e\u092e\u0949\u0932'), false);
  assert.equal(serialized.includes('Paracetamol'), false);
});

test('the fidelity check is honest about what it can and cannot prove', () => {
  // It proves no NUMBER was lost, and - for English - that each value is present.
  const item = { kind: 'medication', dose: '500 mg', frequency: 'every 6 hours', duration: '3 days', route: 'oral' };
  assert.equal(languageVariants.fidelityCheck(item, 'Paracetamol 500 mg by mouth every 6 hours for 3 days', 'en').passed, true);
  assert.equal(languageVariants.fidelityCheck(item, 'Take it as needed', 'en').passed, false);
  assert.equal(languageVariants.fidelityCheck(item, '\u0926\u0935\u093e 500 mg \u0939\u0930 6 \u0918\u0902\u091f\u0947, 3 \u0926\u093f\u0928', 'hi').passed, true);
  // It does NOT claim to understand Hindi: a numbers-only guard cannot.
  const hindiWarning = languageVariants.fidelityCheck(item, '\u092a\u0942\u0930\u0940 \u0916\u0941\u0930\u093e\u0915 \u0932\u0947\u0902', 'hi');
  assert.equal(hindiWarning.passed, false);
  assert.ok(hindiWarning.warnings.length > 0);
});
