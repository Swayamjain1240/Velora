'use strict';

// Part 8 exit gate - clinic-defined check-in templates: versioning, reviewer
// activation, supersession, frozen wording after activation, and the denial
// paths (admin, patient, caregiver, other clinic, unverified reviewer).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const harness = require('../helpers/setup');

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

const DEFINITION = {
  key: 'post-op-wound',
  title: 'Post-operative wound check',
  description: 'Two weeks of wound checks after discharge.',
  questions: [
    { id: 'pain_level', prompt: 'How would you rate your pain today?', kind: 'scale', scaleMin: 0, scaleMax: 10 },
    {
      id: 'wound_state',
      prompt: 'Is the wound area red, hot or leaking?',
      kind: 'choice',
      options: ['no', 'red', 'hot', 'leaking'],
    },
  ],
  cadence: { startOffsetDays: 1, everyDays: 2, horizonDays: 14 },
  responseWindowHours: 24,
  reviewRules: [
    {
      id: 'pain_high',
      label: 'Pain score was high - a clinician should look at this',
      when: { questionId: 'pain_level', operator: 'at_least', value: 7 },
    },
  ],
};

async function setup() {
  const ctx = {};
  const a = await harness.makeClinic();
  ctx.clinic = a.clinic;
  ctx.adminCtx = await harness.signInStaff(app, a.admin.user.email);

  const coord = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  ctx.coordCtx = await harness.signInStaff(app, coord.user.email);
  ctx.coord = coord;

  const reviewer = await harness.makeMember(a.clinic, {
    roleKey: 'clinical_reviewer',
    eligibility: 'verified',
  });
  ctx.reviewerCtx = await harness.signInStaff(app, reviewer.user.email);
  ctx.reviewer = reviewer;

  const unverified = await harness.makeMember(a.clinic, { roleKey: 'clinical_reviewer' });
  ctx.unverifiedCtx = await harness.signInStaff(app, unverified.user.email);

  const b = await harness.makeClinic({ codePrefix: 'OTHER' });
  ctx.otherClinic = b.clinic;
  const otherCoord = await harness.makeMember(b.clinic, { roleKey: 'care_coordinator' });
  ctx.otherClinicCtx = await harness.signInStaff(app, otherCoord.user.email);
  // A peer clinic's VERIFIED reviewer holds the activation permission, so the
  // cross-tenant denial below is a scoping result and not a permission result.
  const otherReviewer = await harness.makeMember(b.clinic, {
    roleKey: 'clinical_reviewer',
    eligibility: 'verified',
  });
  ctx.otherReviewerCtx = await harness.signInStaff(app, otherReviewer.user.email);

  return ctx;
}

function createTemplate(ctx, body = {}, agent = ctx.coordCtx) {
  return agent.a.post('/api/check-in-templates').set('X-CSRF-Token', agent.csrf).send({ ...DEFINITION, ...body });
}

function activateTemplate(ctx, templateId, body = {}, agent = ctx.reviewerCtx) {
  return agent.a
    .post(`/api/check-in-templates/${templateId}/activate`)
    .set('X-CSRF-Token', agent.csrf)
    .send({ expectedRevision: body.expectedRevision ?? 1, ...body });
}

test('a coordinator drafts a clinic template and it starts as version 1 in draft', async () => {
  const ctx = await setup();
  const res = await createTemplate(ctx);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.template.version, 1);
  assert.equal(res.body.template.state, 'draft');
  assert.equal(res.body.template.key, 'post-op-wound');
  assert.equal(res.body.template.reviewRules.length, 1);
  assert.match(res.body.template.note, /workflow aids/i);
});

test('a draft can be edited with a revision guard, and an active version cannot', async () => {
  const ctx = await setup();
  const created = await createTemplate(ctx);
  const id = created.body.template.id;

  const updated = await ctx.coordCtx.a
    .patch(`/api/check-in-templates/${id}`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ expectedRevision: 1, title: 'Post-operative wound check (v1)' });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.template.revision, 2);

  const stale = await ctx.coordCtx.a
    .patch(`/api/check-in-templates/${id}`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ expectedRevision: 1, title: 'Stale write' });
  assert.equal(stale.status, 409);

  const activated = await activateTemplate(ctx, id, { expectedRevision: 2 });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  assert.equal(activated.body.template.state, 'active');

  const frozen = await ctx.coordCtx.a
    .patch(`/api/check-in-templates/${id}`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ expectedRevision: 3, title: 'Rewrite what the patient was asked' });
  assert.equal(frozen.status, 409, 'an active version is frozen');
  assert.match(frozen.body.error.message, /new version/i);

  const stored = await harness.models.CheckInTemplateVersion.findById(id).lean();
  assert.equal(stored.title, 'Post-operative wound check (v1)');
});

test('only a clinic-verified reviewer may activate a template', async () => {
  const ctx = await setup();
  const created = await createTemplate(ctx);
  const id = created.body.template.id;

  const byCoordinator = await activateTemplate(ctx, id, {}, ctx.coordCtx);
  assert.equal(byCoordinator.status, 403);

  const byUnverified = await activateTemplate(ctx, id, {}, ctx.unverifiedCtx);
  assert.equal(byUnverified.status, 403, 'reviewer role without verified eligibility is refused');

  const byAdmin = await activateTemplate(ctx, id, {}, ctx.adminCtx);
  assert.equal(byAdmin.status, 403, 'admin status alone never activates clinical configuration');

  const byOtherClinic = await activateTemplate(ctx, id, {}, ctx.otherReviewerCtx);
  assert.equal(byOtherClinic.status, 404, 'another clinic sees a scoped 404');

  const crossClinicRead = await ctx.otherReviewerCtx.a.get(
    `/api/check-in-templates/${id}`
  );
  assert.equal(crossClinicRead.status, 404, 'another clinic cannot read the template either');

  const stillDraft = await harness.models.CheckInTemplateVersion.findById(id).lean();
  assert.equal(stillDraft.state, 'draft');
});

test('activating a new version supersedes the previous one and keeps its wording', async () => {
  const ctx = await setup();
  const first = await createTemplate(ctx);
  await activateTemplate(ctx, first.body.template.id);

  const second = await createTemplate(ctx, { title: 'Post-operative wound check (v2)' });
  assert.equal(second.body.template.version, 2);
  const activated = await activateTemplate(ctx, second.body.template.id, { note: 'Reviewed the new wording.' });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  assert.equal(activated.body.supersededVersion, 1);

  const versions = await harness.models.CheckInTemplateVersion.find({
    key: 'post-op-wound',
  })
    .sort({ version: 1 })
    .lean();
  assert.equal(versions.length, 2);
  assert.equal(versions[0].state, 'superseded');
  assert.equal(versions[0].supersededByVersion, 2);
  assert.equal(versions[1].state, 'active');

  // A superseded version can never be activated again.
  const reactivate = await activateTemplate(ctx, first.body.template.id, { expectedRevision: 2 });
  assert.equal(reactivate.status, 409);
});

test('re-activating the active version is idempotent and writes no second history', async () => {
  const ctx = await setup();
  const created = await createTemplate(ctx);
  const id = created.body.template.id;
  await activateTemplate(ctx, id);

  const again = await activateTemplate(ctx, id, { expectedRevision: 1 });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.idempotent, true);
  const events = await harness.models.AuditEvent.countDocuments({
    action: 'checkin.template.activated',
  });
  assert.equal(events, 1);
});

test('a definition with diagnostic wording or an autonomous action is refused at write time', async () => {
  const ctx = await setup();
  const diagnostic = await createTemplate(ctx, {
    reviewRules: [
      {
        id: 'abnormal',
        label: 'Abnormal recovery detected',
        when: { questionId: 'pain_level', operator: 'at_least', value: 5 },
      },
    ],
  });
  assert.equal(diagnostic.status, 400);
  assert.match(diagnostic.body.error.message, /diagnostic wording/i);

  const autonomous = await createTemplate(ctx, {
    reviewRules: [
      {
        id: 'auto',
        label: 'Needs a clinician to look at the wound report',
        when: { questionId: 'wound_state', operator: 'equals', values: ['red'] },
        action: 'escalate_autonomously',
      },
    ],
  });
  assert.equal(autonomous.status, 400);

  const dangling = await createTemplate(ctx, {
    reviewRules: [
      {
        id: 'dangling',
        label: 'Needs a clinician to look',
        when: { questionId: 'not_a_question', operator: 'answered' },
      },
    ],
  });
  assert.equal(dangling.status, 400);

  assert.equal(await harness.models.CheckInTemplateVersion.countDocuments({}), 0);
});

test('unknown fields, a bad cadence and a huge definition are rejected before any write', async () => {
  const ctx = await setup();
  const unknown = await createTemplate(ctx, { diagnostic: true });
  assert.equal(unknown.status, 400);

  const badCadence = await createTemplate(ctx, {
    cadence: { startOffsetDays: 1, everyDays: 30, horizonDays: 7 },
  });
  assert.equal(badCadence.status, 400);

  const tooManyQuestions = await createTemplate(ctx, {
    questions: Array.from({ length: 31 }, (_, i) => ({
      id: `q_${i}`,
      prompt: `Question ${i}`,
      kind: 'text',
    })),
  });
  assert.equal(tooManyQuestions.status, 400);

  assert.equal(await harness.models.CheckInTemplateVersion.countDocuments({}), 0);
});

test('patients, caregivers and clinic staff outside the catalog cannot read templates', async () => {
  const ctx = await setup();
  const created = await createTemplate(ctx);
  await activateTemplate(ctx, created.body.template.id);

  const patientUser = await harness.makeMember(ctx.clinic, { roleKey: 'patient' });
  const patientCtx = await harness.signInStaff(app, patientUser.user.email);
  const byPatient = await patientCtx.a.get('/api/check-in-templates');
  assert.equal(byPatient.status, 403);
  const patientWrite = await createTemplate(ctx, {}, patientCtx);
  assert.equal(patientWrite.status, 403);

  const caregiverUser = await harness.makeMember(ctx.clinic, { roleKey: 'caregiver' });
  const caregiverCtx = await harness.signInStaff(app, caregiverUser.user.email);
  const byCaregiver = await caregiverCtx.a.get('/api/check-in-templates');
  assert.equal(byCaregiver.status, 403);

  const byAdmin = await ctx.adminCtx.a.get('/api/check-in-templates');
  assert.equal(byAdmin.status, 403, 'admin alone cannot browse clinic clinical configuration');

  const byOtherClinic = await ctx.otherClinicCtx.a.get('/api/check-in-templates');
  assert.equal(byOtherClinic.status, 200);
  assert.equal(byOtherClinic.body.total, 0, 'another clinic sees its own (empty) catalog');

  const byReviewer = await ctx.reviewerCtx.a.get('/api/check-in-templates');
  assert.equal(byReviewer.status, 200);
  assert.equal(byReviewer.body.total, 1);
});

test('the active template list is what materialisation will read', async () => {
  const ctx = await setup();
  const first = await createTemplate(ctx);
  await activateTemplate(ctx, first.body.template.id);
  const second = await createTemplate(ctx, { key: 'post-op-mobility', title: 'Mobility check' });
  await activateTemplate(ctx, second.body.template.id);

  const { checkInTemplateService } = { checkInTemplateService: require('../../src/services/checkInTemplateService') };
  const active = await checkInTemplateService.listActive({ clinicId: ctx.clinic.id });
  assert.equal(active.length, 2);
  assert.deepEqual(active.map((t) => t.key).sort(), ['post-op-mobility', 'post-op-wound']);

  const one = await checkInTemplateService.listActive({ clinicId: ctx.clinic.id, keys: ['post-op-mobility'] });
  assert.equal(one.length, 1);
  assert.equal(one[0].key, 'post-op-mobility');
});
