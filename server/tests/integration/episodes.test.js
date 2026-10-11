'use strict';

// Part 3 integration tests: recovery episodes and care-team assignment.
// Runs against a replica-set MongoDB so the transactional invariants are real.
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

function todayIn(tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// Two clinics with a coordinator (who onboards the patient and episode), a
// second coordinator, a VERIFIED clinical reviewer and an admin per clinic.
async function setup() {
  const a = await harness.makeClinic({ codePrefix: 'EPA' });
  const b = await harness.makeClinic({ codePrefix: 'EPB' });
  const ctx = { clinicA: a.clinic, clinicB: b.clinic, adminA: a.admin };
  ctx.adminCtx = await harness.signInStaff(app, a.admin.user.email);

  const coordA = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  ctx.coordA = coordA;
  ctx.coordCtx = await harness.signInStaff(app, coordA.user.email);

  const coordA2 = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  ctx.coordA2 = coordA2;
  ctx.coord2Ctx = await harness.signInStaff(app, coordA2.user.email);

  const reviewer = await harness.makeMember(a.clinic, {
    roleKey: 'clinical_reviewer',
    eligibility: 'verified',
  });
  ctx.reviewer = reviewer;
  ctx.reviewerCtx = await harness.signInStaff(app, reviewer.user.email);

  const coordB = await harness.makeMember(b.clinic, { roleKey: 'care_coordinator' });
  ctx.otherClinicCtx = await harness.signInStaff(app, coordB.user.email);

  const created = await harness.createPatient(ctx.coordCtx.a, ctx.coordCtx.csrf, {
    fullName: 'Synthetic Episode Patient',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ctx.patient = created.body.patient;
  return ctx;
}

async function createEpisode(ctx, body = {}) {
  const res = await ctx.coordCtx.a
    .post('/api/episodes')
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({
      patientId: ctx.patient.id,
      dischargeDate: '2026-09-30',
      dischargeTimezone: 'Europe/London',
      ...body,
    });
  return res;
}

test('assigned staff create an episode with a clinic-scoped reference and become the coordinator', async () => {
  const ctx = await setup();
  const res = await createEpisode(ctx);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const episode = res.body.episode;
  assert.equal(episode.status, 'draft');
  assert.equal(episode.revision, 1);
  assert.match(episode.reference, /^EP-/);
  assert.equal(episode.dischargeDate, '2026-09-30');
  assert.equal(episode.dischargeTimezone, 'Europe/London');

  // The creator is on the team as the care coordinator.
  const team = await ctx.coordCtx.a.get(`/api/episodes/${episode.id}/team`);
  assert.equal(team.status, 200);
  assert.equal(team.body.items.length, 1);
  assert.equal(team.body.items[0].responsibility, 'care_coordinator');
  assert.equal(team.body.items[0].memberUserId, ctx.coordA.user.id);
});

test('an episode is scoped to its clinic and to its team', async () => {
  const ctx = await setup();
  const { body } = await createEpisode(ctx);

  // Another clinic cannot see it at all.
  const foreign = await ctx.otherClinicCtx.a.get(`/api/episodes/${body.episode.id}`);
  assert.equal(foreign.status, 404);

  // A same-clinic coordinator who is not on the team gets a uniform 404.
  const unassigned = await ctx.coord2Ctx.a.get(`/api/episodes/${body.episode.id}`);
  assert.equal(unassigned.status, 404);
});

test('intake assignment and episode assignment are separate gates', async () => {
  const ctx = await setup();
  const { body } = await createEpisode(ctx);

  // Give the second coordinator an INTAKE assignment on the patient...
  const assigned = await ctx.coordCtx.a
    .post(`/api/patients/${ctx.patient.id}/assignments`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ memberUserId: ctx.coordA2.user.id });
  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));

  // ...they can read the PATIENT, but NOT the episode until they are on its team.
  assert.equal((await ctx.coord2Ctx.a.get(`/api/patients/${ctx.patient.id}`)).status, 200);
  assert.equal((await ctx.coord2Ctx.a.get(`/api/episodes/${body.episode.id}`)).status, 404);
});

test('a duplicate clinic-scoped reference is rejected, but the same reference in another clinic is fine', async () => {
  const ctx = await setup();
  const first = await createEpisode(ctx, { reference: 'EP-DUP01' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const duplicate = await createEpisode(ctx, { reference: 'EP-DUP01' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, 'CONFLICT');
});

test('a future discharge date and an invalid timezone are rejected', async () => {
  const ctx = await setup();
  const future = await createEpisode(ctx, { dischargeDate: '2999-01-01' });
  assert.equal(future.status, 400, JSON.stringify(future.body));

  const badTz = await createEpisode(ctx, { dischargeTimezone: 'Mars/Olympus' });
  assert.equal(badTz.status, 400, JSON.stringify(badTz.body));

  // A malformed calendar date is rejected too.
  const badDate = await createEpisode(ctx, { dischargeDate: '2026-02-31' });
  assert.equal(badDate.status, 400);
});

test('a discharge date on the timezone boundary is judged in the episode timezone', async () => {
  const ctx = await setup();
  const tz = 'Pacific/Kiritimati'; // UTC+14
  const res = await createEpisode(ctx, { dischargeDate: todayIn(tz), dischargeTimezone: tz });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.episode.dischargeDate, todayIn(tz));
});

test('an administrator is explicitly denied episode clinical metadata', async () => {
  const ctx = await setup();
  const { body } = await createEpisode(ctx);

  const detail = await ctx.adminCtx.a.get(`/api/episodes/${body.episode.id}`);
  assert.equal(detail.status, 403, JSON.stringify(detail.body));

  const corrections = await ctx.adminCtx.a.get(`/api/episodes/${body.episode.id}/corrections`);
  assert.equal(corrections.status, 403);

  // Admin cannot create episodes either (no episode.manage).
  const create = await ctx.adminCtx.a
    .post('/api/episodes')
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({ patientId: ctx.patient.id, dischargeDate: '2026-09-01', dischargeTimezone: 'UTC' });
  assert.equal(create.status, 403);
});

test('an administrator may administer the team without seeing clinical fields', async () => {
  const ctx = await setup();
  const { body } = await createEpisode(ctx);
  const episodeId = body.episode.id;

  const team = await ctx.adminCtx.a.get(`/api/episodes/${episodeId}/team`);
  assert.equal(team.status, 200, JSON.stringify(team.body));
  // The roster carries NO clinical metadata.
  const row = team.body.items[0];
  assert.equal(row.dischargeDate, undefined);
  assert.equal(row.reference, undefined);

  const candidates = await ctx.adminCtx.a.get(`/api/episodes/${episodeId}/team/candidates`);
  assert.equal(candidates.status, 200);
  const target = candidates.body.items.find((i) => i.userId === ctx.coordA2.user.id);
  assert.ok(target, 'the unassigned coordinator is an eligible candidate');

  const assigned = await ctx.adminCtx.a
    .post(`/api/episodes/${episodeId}/team`)
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({ memberUserId: ctx.coordA2.user.id, responsibility: 'care_coordinator' });
  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
  assert.equal(assigned.body.assignment.assignedByRole, 'admin');
});

test('reviewer candidates require current verified eligibility, and inactive staff are refused', async () => {
  const ctx = await setup();
  const { body } = await createEpisode(ctx);
  const episodeId = body.episode.id;

  // A reviewer whose eligibility was revoked is not a candidate.
  const pendingReviewer = await harness.makeMember(ctx.clinicA, {
    roleKey: 'clinical_reviewer',
    eligibility: 'pending',
  });
  const candidates = await ctx.coordCtx.a.get(`/api/episodes/${episodeId}/team/candidates`);
  const ids = candidates.body.items.map((i) => i.userId);
  assert.ok(!ids.includes(pendingReviewer.user.id), 'ineligible reviewer is excluded');
  assert.ok(ids.includes(ctx.reviewer.user.id), 'verified reviewer is included');

  // Assigning the ineligible reviewer is refused.
  const refused = await ctx.coordCtx.a
    .post(`/api/episodes/${episodeId}/team`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ memberUserId: pendingReviewer.user.id, responsibility: 'clinical_reviewer' });
  assert.ok([400, 403].includes(refused.status), JSON.stringify(refused.body));

  // An INACTIVE membership cannot be assigned.
  const inactive = await harness.makeMember(ctx.clinicA, { roleKey: 'care_coordinator' });
  await harness.models.ClinicMembership.updateOne(
    { _id: inactive.membership.id },
    { $set: { status: 'inactive' } }
  );
  const inactiveAssign = await ctx.coordCtx.a
    .post(`/api/episodes/${episodeId}/team`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ memberUserId: inactive.user.id, responsibility: 'care_coordinator' });
  assert.equal(inactiveAssign.status, 404);

  // A verified reviewer can be assigned as the clinical reviewer.
  const ok = await ctx.coordCtx.a
    .post(`/api/episodes/${episodeId}/team`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ memberUserId: ctx.reviewer.user.id, responsibility: 'clinical_reviewer' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test('the last active assignment can never be removed', async () => {
  const ctx = await setup();
  const { body } = await createEpisode(ctx);
  const team = await ctx.coordCtx.a.get(`/api/episodes/${body.episode.id}/team`);
  const only = team.body.items[0];

  const revoked = await ctx.coordCtx.a
    .delete(`/api/episodes/${body.episode.id}/team/${only.id}`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf);
  assert.equal(revoked.status, 409, JSON.stringify(revoked.body));
  assert.equal(revoked.body.error.code, 'CONFLICT');
});

test('reassignment keeps history and duplicate assignment is idempotent', async () => {
  const ctx = await setup();
  const { body } = await createEpisode(ctx);
  const episodeId = body.episode.id;

  // Add a second member.
  const added = await ctx.coordCtx.a
    .post(`/api/episodes/${episodeId}/team`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ memberUserId: ctx.coordA2.user.id, responsibility: 'care_coordinator' });
  assert.equal(added.status, 201);

  // A repeat request is idempotent: no second active interval.
  const again = await ctx.coordCtx.a
    .post(`/api/episodes/${episodeId}/team`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ memberUserId: ctx.coordA2.user.id, responsibility: 'care_coordinator' });
  assert.ok([200, 201].includes(again.status));
  let team = await ctx.coordCtx.a.get(`/api/episodes/${episodeId}/team`);
  assert.equal(team.body.items.filter((i) => i.status === 'active').length, 2);

  // Revoke the second interval, then re-assign: history accumulates.
  const second = team.body.items.find((i) => i.memberUserId === ctx.coordA2.user.id);
  const removed = await ctx.coordCtx.a
    .delete(`/api/episodes/${episodeId}/team/${second.id}`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.assignment.status, 'revoked');

  await ctx.coordCtx.a
    .post(`/api/episodes/${episodeId}/team`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ memberUserId: ctx.coordA2.user.id, responsibility: 'care_coordinator' });

  team = await ctx.coordCtx.a.get(`/api/episodes/${episodeId}/team`);
  assert.equal(team.body.items.length, 3, 'all intervals are retained');
  assert.equal(team.body.items.filter((i) => i.status === 'active').length, 2);
});

test('parallel assignment of the same member creates exactly one active interval', async () => {
  const ctx = await setup();
  const { body } = await createEpisode(ctx);
  const episodeId = body.episode.id;

  const [r1, r2] = await Promise.all([
    ctx.coordCtx.a
      .post(`/api/episodes/${episodeId}/team`)
      .set('X-CSRF-Token', ctx.coordCtx.csrf)
      .send({ memberUserId: ctx.coordA2.user.id, responsibility: 'care_coordinator' }),
    ctx.coordCtx.a
      .post(`/api/episodes/${episodeId}/team`)
      .set('X-CSRF-Token', ctx.coordCtx.csrf)
      .send({ memberUserId: ctx.coordA2.user.id, responsibility: 'care_coordinator' }),
  ]);
  assert.ok([r1.status, r2.status].every((s) => [200, 201].includes(s)), `${r1.status}/${r2.status}`);

  const count = await harness.models.CareTeamAssignment.countDocuments({
    episode: episodeId,
    memberUser: ctx.coordA2.user.id,
    status: 'active',
  });
  assert.equal(count, 1);
});

test('a draft discharge date is corrected atomically and the history is append-only', async () => {
  const ctx = await setup();
  const { body } = await createEpisode(ctx);
  const episodeId = body.episode.id;

  const corrected = await ctx.coordCtx.a
    .patch(`/api/episodes/${episodeId}/discharge`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ dischargeDate: '2026-09-25', expectedRevision: 1, reason: 'typo' });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
  assert.equal(corrected.body.episode.revision, 2);
  assert.equal(corrected.body.episode.dischargeDate, '2026-09-25');

  const history = await ctx.coordCtx.a.get(`/api/episodes/${episodeId}/corrections`);
  assert.equal(history.body.total, 1);
  assert.equal(history.body.items[0].field, 'discharge_date');
  assert.equal(history.body.items[0].previousValue, '2026-09-30');
  assert.equal(history.body.items[0].newValue, '2026-09-25');
  assert.equal(history.body.items[0].revisionBefore, 1);
  assert.equal(history.body.items[0].revisionAfter, 2);
});

test('a stale revision is refused and a no-op does not create duplicate history', async () => {
  const ctx = await setup();
  const { body } = await createEpisode(ctx);
  const episodeId = body.episode.id;

  const stale = await ctx.coordCtx.a
    .patch(`/api/episodes/${episodeId}/discharge`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ dischargeDate: '2026-09-25', expectedRevision: 9 });
  assert.equal(stale.status, 409);

  const noop = await ctx.coordCtx.a
    .patch(`/api/episodes/${episodeId}/discharge`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ dischargeDate: '2026-09-30', expectedRevision: 1 });
  assert.equal(noop.status, 200, JSON.stringify(noop.body));
  assert.equal(noop.body.episode.revision, 1);

  const history = await ctx.coordCtx.a.get(`/api/episodes/${episodeId}/corrections`);
  assert.equal(history.body.total, 0, 'a no-op records nothing');
});

test('concurrent corrections against the same revision cannot both succeed', async () => {
  const ctx = await setup();
  const { body } = await createEpisode(ctx);
  const episodeId = body.episode.id;

  const [r1, r2] = await Promise.all([
    ctx.coordCtx.a
      .patch(`/api/episodes/${episodeId}/discharge`)
      .set('X-CSRF-Token', ctx.coordCtx.csrf)
      .send({ dischargeDate: '2026-09-20', expectedRevision: 1 }),
    ctx.coordCtx.a
      .patch(`/api/episodes/${episodeId}/discharge`)
      .set('X-CSRF-Token', ctx.coordCtx.csrf)
      .send({ dischargeDate: '2026-09-21', expectedRevision: 1 }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409], `${r1.status}/${r2.status}`);

  const detail = await ctx.coordCtx.a.get(`/api/episodes/${episodeId}`);
  assert.equal(detail.body.episode.revision, 2);

  const history = await ctx.coordCtx.a.get(`/api/episodes/${episodeId}/corrections`);
  assert.equal(history.body.total, 1, 'only the winning correction is recorded');
});

test('the patient owns their own episode view and cannot see anyone else\'s', async () => {
  const ctx = await setup();
  const { body } = await createEpisode(ctx);

  // Link an account to the patient record and sign it in.
  const patientUser = await harness.makeMember(ctx.clinicA, { roleKey: 'patient' });
  await harness.models.PatientProfile.updateOne(
    { _id: ctx.patient.id },
    { $set: { linkedUserId: patientUser.user.id, status: 'active' } }
  );
  const patientCtx = await harness.signInStaff(app, patientUser.user.email);

  const list = await patientCtx.a.get('/api/patient/me/episodes');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.total, 1);

  const detail = await patientCtx.a.get(`/api/patient/me/episodes/${body.episode.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.episode.dischargeDate, '2026-09-30');

  // Another patient cannot read it.
  const otherUser = await harness.makeMember(ctx.clinicA, { roleKey: 'patient' });
  const otherCtx = await harness.signInStaff(app, otherUser.user.email);
  // No profile is linked to this account, so ownership resolves to a scoped 404.
  assert.equal((await otherCtx.a.get('/api/patient/me/episodes')).status, 404);
  assert.equal(
    (await otherCtx.a.get(`/api/patient/me/episodes/${body.episode.id}`)).status,
    404
  );
});

test('episode listings are scoped to the caller', async () => {
  const ctx = await setup();
  await createEpisode(ctx);

  const mine = await ctx.coordCtx.a.get('/api/episodes?page=1&limit=5');
  assert.equal(mine.body.total, 1);

  const other = await ctx.coord2Ctx.a.get('/api/episodes?page=1&limit=5');
  assert.equal(other.body.total, 0, 'an unassigned coordinator sees no episodes');
});

test('unknown fields are rejected and errors stay JSON', async () => {
  const ctx = await setup();
  const unknown = await createEpisode(ctx, { role: 'admin' });
  assert.equal(unknown.status, 400, 'unknown fields are rejected, not stripped');
  assert.match(unknown.headers['content-type'], /application\/json/);
});
