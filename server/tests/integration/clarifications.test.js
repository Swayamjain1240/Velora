'use strict';

// Part 8 exit gate: the clarification queue.
//
// The assertions the part turns on: every transition stores actor/time/history,
// reopening keeps the earlier answer, a CLINICAL question is answerable only by
// an assigned eligible clinical reviewer while an OPERATIONAL one belongs to the
// coordinator, an internal note never reaches the patient, and every denial path
// (admin, unassigned staff, another clinic, a caregiver without the scope, a
// revoked grant) is exercised. The surfaces always carry the clinic response
// hours and never imply continuous monitoring.
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

async function setup({ withCaregiver = false, clinicHours = true } = {}) {
  const a = await harness.makeClinic({ codePrefix: 'QLNA' });
  const b = await harness.makeClinic({ codePrefix: 'QLNB' });
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
  ctx.reviewer = reviewer;
  ctx.reviewerCtx = await harness.signInStaff(app, reviewer.user.email);
  const peerReviewer = await harness.makeMember(a.clinic, {
    roleKey: 'clinical_reviewer',
    eligibility: 'verified',
  });
  ctx.peerReviewerCtx = await harness.signInStaff(app, peerReviewer.user.email);
  const coordReviewer = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  ctx.otherCoordId = coordReviewer.user.id;
  ctx.adminCtx = await harness.signInStaff(app, a.admin.user.email);

  const otherCoord = await harness.makeMember(b.clinic, { roleKey: 'care_coordinator' });
  ctx.otherClinicCtx = await harness.signInStaff(app, otherCoord.user.email);

  const created = await harness.createPatient(ctx.coordCtx.a, ctx.coordCtx.csrf, {
    fullName: 'Synthetic Question Patient',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ctx.patient = created.body.patient;

  const episodeRes = await ctx.coordCtx.a
    .post('/api/episodes')
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ patientId: ctx.patient.id, dischargeDate: '2026-09-20', dischargeTimezone: 'UTC' });
  assert.equal(episodeRes.status, 201, JSON.stringify(episodeRes.body));
  ctx.episode = episodeRes.body.episode;

  const patientUser = await harness.makeMember(a.clinic, { roleKey: 'patient' });
  await harness.models.PatientProfile.updateOne(
    { _id: ctx.patient.id },
    { $set: { linkedUserId: patientUser.user.id, status: 'active' } }
  );
  ctx.patientEmail = patientUser.user.email;
  ctx.patientCtx = await harness.signInStaff(app, patientUser.user.email);

  // The assigned, verified clinical reviewer for this episode.
  const assigned = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/team`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ memberUserId: reviewer.user.id, responsibility: 'clinical_reviewer' });
  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));

  if (clinicHours) {
    const hours = await ctx.adminCtx.a
      .patch('/api/clinic')
      .set('X-CSRF-Token', ctx.adminCtx.csrf)
      .send({
        responseHours: {
          display: 'Mon-Fri 09:00-17:00 (clinic time)',
          timezone: 'UTC',
          from: '09:00',
          to: '17:00',
          monitoredContinuously: false,
        },
        emergencyInstructions: {
          display: 'If you feel unwell urgently, call your local emergency number.',
          contactPhone: '+441234567890',
        },
      });
    assert.equal(hours.status, 200, JSON.stringify(hours.body));
  }

  if (withCaregiver) {
    ctx.caregiverCtx = await grantCaregiver(ctx, ['view_profile', 'ask_questions']);
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
  return { ...signedIn, grantId: accepted.body.grant.id };
}

function threadPath(ctx, suffix = '') {
  return `/api/episodes/${ctx.episode.id}/questions${suffix}`;
}

async function openAsPatient(ctx, body = {}, agent = ctx.patientCtx, episodeId = ctx.episode.id) {
  return agent.a
    .post(`/api/patient/me/episodes/${episodeId}/questions`)
    .set('X-CSRF-Token', agent.csrf)
    .send({
      kind: 'operational',
      subject: 'Dressing change question',
      body: 'Should I change the dressing myself this week?',
      ...body,
    });
}

async function openAsStaff(ctx, body = {}, agent = ctx.coordCtx) {
  return agent.a
    .post(threadPath(ctx))
    .set('X-CSRF-Token', agent.csrf)
    .send({
      kind: 'operational',
      subject: 'Discharge paperwork',
      body: 'The discharge summary needs a correction.',
      ...body,
    });
}

async function assign(ctx, threadId, assigneeUserId, agent = ctx.coordCtx) {
  return agent.a
    .post(threadPath(ctx, `/${threadId}/assign`))
    .set('X-CSRF-Token', agent.csrf)
    .send({ assigneeUserId });
}

async function answer(ctx, threadId, body, agent = ctx.coordCtx) {
  return agent.a
    .post(threadPath(ctx, `/${threadId}/answer`))
    .set('X-CSRF-Token', agent.csrf)
    .send({ body });
}

async function closeThread(ctx, threadId, agent = ctx.patientCtx, note) {
  const base = agent === ctx.patientCtx ? '/api/patient/me/questions' : '/api/caregiver/me/questions';
  return agent.a
    .post(`${base}/${threadId}/close`)
    .set('X-CSRF-Token', agent.csrf)
    .send({ note });
}

test('a patient asks a question and every transition stores actor, time and history', async () => {
  const ctx = await setup();
  const created = await openAsPatient(ctx);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const thread = created.body.thread;
  assert.equal(thread.state, 'open');
  assert.equal(thread.kind, 'operational');
  assert.equal(thread.openedByRole, 'patient');
  assert.equal(thread.history.length, 1);
  assert.equal(thread.history[0].action, 'open');
  assert.equal(thread.history[0].actorLabel, ctx.patientEmail);
  assert.ok(thread.history[0].at, 'the transition carries its time');
  assert.equal(thread.messageCount, 2, 'the question and the system line');

  const detail = await ctx.patientCtx.a.get(`/api/patient/me/questions/${thread.id}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.thread.messages.length, 2);
  assert.equal(detail.body.thread.messages[0].kind, 'question');
  assert.match(detail.body.thread.messages[1].body, /opened this question/i);
  // The response hours, contact guidance and emergency line travel with it.
  assert.match(detail.body.thread.guidance.display, /Mon-Fri/);
  assert.match(detail.body.thread.guidance.note, /not monitored continuously/i);
  assert.match(detail.body.thread.guidance.emergency.fallback, /not an emergency service/i);

  const assigned = await assign(ctx, thread.id, ctx.otherCoordId);
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  assert.equal(assigned.body.thread.state, 'assigned');
  assert.equal(assigned.body.thread.history.length, 2);
  assert.equal(assigned.body.thread.history[1].action, 'assign');
  assert.equal(assigned.body.thread.history[1].actorRole, 'staff');
});

test('a coordinator answers an operational question, a clinical one needs the assigned reviewer', async () => {
  const ctx = await setup();

  // Operational: the assigned coordinator answers.
  const operational = await openAsPatient(ctx);
  const answered = await answer(ctx, operational.body.thread.id, 'Keep it dry for 48 hours and we will check it.');
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal(answered.body.thread.state, 'answered');
  assert.equal(answered.body.thread.answeredByLabel, ctx.coord.user.email);
  const reply = answered.body.thread.messages.find((m) => m.kind === 'answer');
  assert.equal(reply.answeredAs, 'operational');

  // Clinical: the coordinator may not answer it even though it was asked at them.
  const clinical = await openAsPatient(ctx, {
    kind: 'clinical',
    subject: 'Is this redness a problem?',
    body: 'The area around the wound is red and warm. Should I be worried?',
  });
  assert.equal(clinical.status, 201, JSON.stringify(clinical.body));
  const clinicalId = clinical.body.thread.id;

  const byCoordinator = await answer(ctx, clinicalId, 'That is probably fine.');
  assert.equal(byCoordinator.status, 403, JSON.stringify(byCoordinator.body));
  assert.match(byCoordinator.body.error.message, /assigned, clinic-verified clinical reviewer/i);

  // A peer reviewer who is NOT assigned to the thread may not answer it either.
  const byPeer = await answer(ctx, clinicalId, 'Looks like it should settle.', ctx.peerReviewerCtx);
  assert.equal(byPeer.status, 403, 'a clinical question needs the assignment, not just eligibility');

  // A clinical thread cannot be assigned to a coordinator.
  const wrongAssignee = await assign(ctx, clinicalId, ctx.otherCoordId);
  assert.equal(wrongAssignee.status, 400, JSON.stringify(wrongAssignee.body));
  assert.match(wrongAssignee.body.error.message, /verified clinical reviewer/i);

  const assigned = await assign(ctx, clinicalId, ctx.reviewer.user.id);
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  assert.equal(assigned.body.thread.assignedToLabel, ctx.reviewer.user.email);

  const answeredByReviewer = await answer(
    ctx,
    clinicalId,
    'Redness with warmth should be looked at in person. Please come in tomorrow morning.',
    ctx.reviewerCtx
  );
  assert.equal(answeredByReviewer.status, 200, JSON.stringify(answeredByReviewer.body));
  const clinicalReply = answeredByReviewer.body.thread.messages.find((m) => m.kind === 'answer');
  assert.equal(clinicalReply.answeredAs, 'clinical');

  // The reviewer has no operational answer permission: the two are separate.
  const operationalForReviewer = await answer(
    ctx,
    operational.body.thread.id,
    'Answering out of scope.',
    ctx.reviewerCtx
  );
  assert.equal(operationalForReviewer.status, 403);
});

test('reopening keeps the earlier answer and the whole history', async () => {
  const ctx = await setup();
  const created = await openAsPatient(ctx);
  const id = created.body.thread.id;
  await assign(ctx, id, ctx.otherCoordId);
  await answer(ctx, id, 'Change it on Friday at the clinic.');

  const closed = await closeThread(ctx, id, ctx.patientCtx, 'Answered, thank you.');
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.thread.state, 'closed');
  assert.equal(closed.body.thread.reopenCount, 0);

  // A closed thread cannot be answered again without reopening.
  const answerWhenClosed = await answer(ctx, id, 'One more thing.');
  assert.equal(answerWhenClosed.status, 409, JSON.stringify(answerWhenClosed.body));

  const reopened = await ctx.patientCtx.a
    .post(`/api/patient/me/questions/${id}/reopen`)
    .set('X-CSRF-Token', ctx.patientCtx.csrf)
    .send({ note: 'Still unsure.' });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal(reopened.body.thread.state, 'reopened');
  assert.equal(reopened.body.thread.reopenCount, 1);

  const detail = await ctx.coordCtx.a.get(threadPath(ctx, `/${id}`));
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  const actions = detail.body.thread.history.map((h) => h.action);
  assert.deepEqual(actions, ['open', 'assign', 'answer', 'close', 'reopen']);
  // The earlier answer is still in the conversation, so the patient can re-read it.
  assert.ok(detail.body.thread.messages.some((m) => m.kind === 'answer'));
  assert.equal(detail.body.thread.messages.filter((m) => m.kind === 'answer').length, 1);

  // Reopening an already-reopened thread is refused rather than silently
  // applied, but the reopened thread can be assigned and answered again.
  const twiceReopen = await ctx.patientCtx.a
    .post(`/api/patient/me/questions/${id}/reopen`)
    .set('X-CSRF-Token', ctx.patientCtx.csrf)
    .send({});
  assert.equal(twiceReopen.status, 409, JSON.stringify(twiceReopen.body));
  const assignAgain = await assign(ctx, id, ctx.otherCoordId);
  assert.equal(assignAgain.status, 200, JSON.stringify(assignAgain.body));
  assert.equal(assignAgain.body.thread.state, 'assigned');

  // The history cannot be rewritten.
  const stored = await harness.models.ClarificationThread.findById(id);
  stored.set({ history: [] });
  await assert.rejects(() => stored.save(), /append-only/i);
});

test('an internal note stays internal, and the patient never sees it', async () => {
  const ctx = await setup();
  const created = await openAsPatient(ctx);
  const id = created.body.thread.id;

  const note = await ctx.coordCtx.a
    .post(threadPath(ctx, `/${id}/notes`))
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ body: 'Patient called the ward; the nurse advised a review tomorrow.' });
  assert.equal(note.status, 201, JSON.stringify(note.body));
  assert.equal(note.body.thread.messages.some((m) => m.kind === 'note'), true, 'the team sees it');

  const patientView = await ctx.patientCtx.a.get(`/api/patient/me/questions/${id}`);
  assert.equal(patientView.status, 200);
  assert.equal(
    patientView.body.thread.messages.some((m) => m.kind === 'note'),
    false,
    'an internal note is never returned on the patient surface'
  );
  assert.equal(
    JSON.stringify(patientView.body).includes('called the ward'),
    false
  );

  // A clinical reviewer holds no operational permission, so notes are not theirs.
  const byReviewer = await ctx.reviewerCtx.a
    .post(threadPath(ctx, `/${id}/notes`))
    .set('X-CSRF-Token', ctx.reviewerCtx.csrf)
    .send({ body: 'Internal note.' });
  assert.equal(byReviewer.status, 403);
});

test('the coordinator can move an operational question to the clinical queue', async () => {
  const ctx = await setup();
  const created = await openAsPatient(ctx);
  const id = created.body.thread.id;

  const reclassified = await ctx.coordCtx.a
    .post(threadPath(ctx, `/${id}/reclassify`))
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ note: 'Needs clinical input.' });
  assert.equal(reclassified.status, 200, JSON.stringify(reclassified.body));
  assert.equal(reclassified.body.thread.kind, 'clinical');
  assert.match(
    reclassified.body.thread.messages.at(-1).body,
    /only an assigned clinical reviewer may answer/i
  );

  const coordinatorAnswer = await answer(ctx, id, 'It should be fine.');
  assert.equal(coordinatorAnswer.status, 403, 'the move takes the coordinator out of the loop');

  const already = await ctx.coordCtx.a
    .post(threadPath(ctx, `/${id}/reclassify`))
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({});
  assert.equal(already.status, 409);
});

test('admins, unassigned staff and other clinics are refused', async () => {
  const ctx = await setup();
  const created = await openAsPatient(ctx);
  const id = created.body.thread.id;

  const adminList = await ctx.adminCtx.a.get(threadPath(ctx));
  assert.equal(adminList.status, 403, 'admin status alone cannot browse clarification content');
  const adminAnswer = await answer(ctx, id, 'Answered by an administrator.', ctx.adminCtx);
  assert.equal(adminAnswer.status, 403);
  const adminOpen = await openAsStaff(ctx, {}, ctx.adminCtx);
  assert.equal(adminOpen.status, 403);

  const unassignedList = await ctx.coord2Ctx.a.get(threadPath(ctx));
  assert.equal(unassignedList.status, 403, 'an unassigned colleague sees an explicit refusal');
  const unassignedAnswer = await answer(ctx, id, 'Not mine to answer.', ctx.coord2Ctx);
  assert.equal(unassignedAnswer.status, 403);

  const otherClinic = await ctx.otherClinicCtx.a.get(threadPath(ctx));
  assert.equal(otherClinic.status, 404, 'another clinic cannot see the episode at all');

  // The patient cannot answer, assign or reclassify their own question.
  const patientAnswer = await ctx.patientCtx.a
    .post(threadPath(ctx, `/${id}/answer`))
    .set('X-CSRF-Token', ctx.patientCtx.csrf)
    .send({ body: 'Answering myself.' });
  assert.equal(patientAnswer.status, 403);
  const patientAssign = await ctx.patientCtx.a
    .post(threadPath(ctx, `/${id}/assign`))
    .set('X-CSRF-Token', ctx.patientCtx.csrf)
    .send({ assigneeUserId: ctx.reviewer.user.id });
  assert.equal(patientAssign.status, 403);
});

test('a caregiver needs the ask_questions scope, and the clinic comes from the grant', async () => {
  const ctx = await setup({ withCaregiver: true });
  const opened = await ctx.caregiverCtx.a
    .post(`/api/caregiver/me/episodes/${ctx.episode.id}/questions`)
    .set('X-CSRF-Token', ctx.caregiverCtx.csrf)
    .send({
      kind: 'operational',
      subject: 'Pick-up arrangements',
      body: 'Can someone collect the prescription on Saturday?',
    });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  assert.equal(opened.body.thread.openedByRole, 'caregiver');
  const id = opened.body.thread.id;

  const listed = await ctx.caregiverCtx.a.get(
    `/api/caregiver/me/patients/${ctx.patient.id}/questions?page=1&limit=10`
  );
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.total, 1);
  assert.match(listed.body.guidance.note, /not monitored continuously/i);

  const reply = await ctx.caregiverCtx.a
    .post(`/api/caregiver/me/questions/${id}/messages`)
    .set('X-CSRF-Token', ctx.caregiverCtx.csrf)
    .send({ body: 'Saturday morning would be best.' });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  assert.equal(reply.body.thread.messages.filter((m) => m.kind === 'question').length, 2);

  // Losing the scope closes the surface with a 404, and a revoked grant too.
  await harness.models.CaregiverGrant.updateOne(
    { _id: ctx.caregiverCtx.grantId },
    { $set: { scopes: ['view_profile'] } }
  );
  const noScope = await ctx.caregiverCtx.a.get(
    `/api/caregiver/me/patients/${ctx.patient.id}/questions`
  );
  assert.equal(noScope.status, 404);

  await harness.models.CaregiverGrant.updateOne(
    { _id: ctx.caregiverCtx.grantId },
    { $set: { scopes: ['view_profile', 'ask_questions'], status: 'revoked', revokedAt: new Date() } }
  );
  const revoked = await ctx.caregiverCtx.a.get(
    `/api/caregiver/me/patients/${ctx.patient.id}/questions`
  );
  assert.equal(revoked.status, 404);
});

test('a question may name the check-in it came from without re-interpreting it', async () => {
  const ctx = await setup();
  const created = await openAsPatient(ctx, {
    responseId: String(ctx.patient.id),
  });
  // The response link is a reference only, and an unknown one is a plain field
  // the validator accepts; the service stores it verbatim.
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.ok(created.body.thread.response);

  const malformed = await openAsPatient(ctx, { responseId: 'not-an-id' });
  assert.equal(malformed.status, 400);

  const markup = await openAsPatient(ctx, { body: '<script>alert(1)</script>' });
  assert.equal(markup.status, 400, 'markup is refused at write time');
  assert.match(markup.body.error.message, /plain text/i);

  const empty = await openAsPatient(ctx, { subject: '' });
  assert.equal(empty.status, 400);

  const unknownField = await openAsPatient(ctx, { priority: 'urgent' });
  assert.equal(unknownField.status, 400, 'unknown fields are refused');
});

test('a clinic with no published hours says so instead of implying cover', async () => {
  const ctx = await setup({ clinicHours: false });
  const created = await openAsPatient(ctx);
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const detail = await ctx.patientCtx.a.get(`/api/patient/me/questions/${created.body.thread.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.thread.guidance.configured, false);
  assert.match(detail.body.thread.guidance.note, /has not published response hours/i);
  assert.equal(detail.body.thread.guidance.monitoredContinuously, false);
  assert.match(detail.body.thread.guidance.emergency.fallback, /not an emergency service/i);
});

test('the patient question surface carries the same durable budget as the staff one', async () => {
  // Control #8: the ask budget (60 per caller per hour) lives in MongoDB, not in
  // process memory, so it survives a restart and holds across server instances.
  // The patient side of "asking a question" shares the staff route's bucket,
  // which is exactly the point: the role decides what you may do, never how
  // often you may do it.
  const ctx = await setup();
  let accepted = 0;
  let last;
  for (let i = 0; i < 61; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    last = await openAsPatient(ctx, { subject: `Budget probe ${i}` });
    if (last.status === 201) accepted += 1;
  }
  assert.equal(accepted, 60, 'the first 60 asks fit inside the hourly budget');
  assert.equal(last.status, 429, JSON.stringify(last.body));
  assert.equal(last.body.error.code, 'RATE_LIMITED');

  // The refusal is a safe, single envelope (control #9) and the reads keep
  // working: the budget is per operation class, not a lockout of the surface.
  const stillReading = await ctx.patientCtx.a.get('/api/patient/me/questions?page=1&limit=10');
  assert.equal(stillReading.status, 200, JSON.stringify(stillReading.body));
  assert.ok(stillReading.body.total >= 60);
});
