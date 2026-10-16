'use strict';

// QA access matrix (role x tenant x resource), cross-cutting rather than
// per-surface.
//
// The per-surface suites each assert their own denials. This file asks the
// opposite question: take a handful of representative endpoints and a spread of
// actors - anonymous, assigned, unassigned, another tenant, an administrator
// without clinical authority, a membership that went inactive, a disabled
// account - and prove that ONLY the entitled actor is served, while operational
// surfaces stay honest (scoped-empty, never leaking) for everybody else. The
// observed codes are printed so the QA matrix document can quote real output
// instead of a design intention.
//
// Expectation vocabulary (each cell traced to requirement evidence):
//   denial       -> 401/403/404 with the safe error envelope
//   served       -> 200 with the entitled content
//   scoped-zero  -> 200 but provably empty of another team's work (dashboard
//                   suites assert "unassigned sees zero", "other clinic zero")
//   aggregate    -> 200 with operational aggregates only (metrics suites assert
//                   admin 200 and coordinator 200; constants grant METRICS_READ
//                   to admin and coordinator)
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

// Two tenants. Clinic A holds the patient, an assigned coordinator (the episode
// CREATOR, and creation records the creator as the first care coordinator), a
// second coordinator who is NOT on the team, an administrator, a membership that
// was deactivated and a user whose account was disabled. Clinic B holds a
// coordinator from a different tenant entirely.
async function setup() {
  const a = await harness.makeClinic({ codePrefix: 'MTXA' });
  const b = await harness.makeClinic({ codePrefix: 'MTXB' });

  const coord = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  const coordCtx = await harness.signInStaff(app, coord.user.email);
  const outsider = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  const outsiderCtx = await harness.signInStaff(app, outsider.user.email);
  const adminCtx = await harness.signInStaff(app, a.admin.user.email);
  const otherClinic = await harness.makeMember(b.clinic, { roleKey: 'care_coordinator' });
  const otherClinicCtx = await harness.signInStaff(app, otherClinic.user.email);

  const deactivated = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  const deactivatedCtx = await harness.signInStaff(app, deactivated.user.email);
  await harness.models.ClinicMembership.updateOne(
    { _id: deactivated.membership._id },
    { $set: { status: 'inactive' } }
  );

  const disabled = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  const disabledCtx = await harness.signInStaff(app, disabled.user.email);
  await harness.models.User.updateOne({ _id: disabled.user._id }, { $set: { status: 'disabled' } });

  const created = await harness.createPatient(coordCtx.a, coordCtx.csrf, {
    fullName: 'Synthetic Matrix Patient',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const patient = created.body.patient;

  const episode = await coordCtx.a
    .post('/api/episodes')
    .set('X-CSRF-Token', coordCtx.csrf)
    .send({ patientId: patient.id, dischargeDate: '2026-09-30', dischargeTimezone: 'Europe/London' });
  assert.equal(episode.status, 201, JSON.stringify(episode.body));

  return {
    clinicA: a.clinic,
    clinicB: b.clinic,
    patient,
    episode: episode.body.episode,
    coord: coord.user,
    coordCtx,
    outsider: outsider.user,
    outsiderCtx,
    adminCtx,
    otherClinicCtx,
    deactivatedCtx,
    disabledCtx,
  };
}

const PATIENT_NAME = 'Synthetic Matrix Patient';

function endpoints(ctx) {
  return [
    { kind: 'clinical', name: 'episode detail', path: `/api/episodes/${ctx.episode.id}` },
    { kind: 'clinical', name: 'episode documents', path: `/api/episodes/${ctx.episode.id}/documents` },
    { kind: 'clinical', name: 'episode plans', path: `/api/episodes/${ctx.episode.id}/plans` },
    { kind: 'clinical', name: 'closure preflight', path: `/api/episodes/${ctx.episode.id}/closure/preflight` },
    { kind: 'clinical', name: 'patient record', path: `/api/patients/${ctx.patient.id}` },
    { kind: 'dashboard', name: 'assigned dashboard', path: '/api/dashboard' },
    { kind: 'administrative', name: 'audit trail', path: '/api/audit' },
    { kind: 'administrative', name: 'retention configuration', path: '/api/retention/categories' },
    { kind: 'operational', name: 'operational metrics', path: '/api/metrics' },
  ];
}

// What each actor is entitled to, per surface kind. Evidence for each cell is
// cited where the surface suite asserts it; the rest follows structurally from
// SYSTEM_ROLES permissions (constants.js) and the default-deny resolvers.
function actorMatrix(ctx) {
  const denial = {
    clinical: 'denial',
    dashboard: 'denial',
    administrative: 'denial',
    operational: 'denial',
  };
  return [
    { label: 'anonymous', agent: null, expect: denial },
    {
      label: 'assigned coordinator',
      agent: ctx.coordCtx.a,
      expect: {
        clinical: 'served',
        dashboard: 'served',
        // Coordinators hold no audit.read / retention.manage (constants.js).
        administrative: 'denial',
        operational: 'aggregate',
      },
    },
    {
      label: 'unassigned same-clinic coordinator',
      agent: ctx.outsiderCtx.a,
      expect: {
        // Same clinic but not on the team: uniform 404 so existence never leaks
        // (plans suite asserts the colleague's uniform 404).
        clinical: 'denial',
        // Dashboard suite: "a coordinator may open the dashboard" but sees none
        // of another care team's work (all counts zero).
        dashboard: 'scoped-zero',
        administrative: 'denial',
        operational: 'aggregate',
      },
    },
    {
      label: 'other-clinic coordinator',
      agent: ctx.otherClinicCtx.a,
      expect: {
        clinical: 'denial',
        // Dashboard suite: "another clinic sees nothing at all" (200, zero).
        dashboard: 'scoped-zero',
        administrative: 'denial',
        operational: 'aggregate',
      },
    },
    {
      label: 'clinic administrator',
      agent: ctx.adminCtx.a,
      expect: {
        // episode suite: "explicitly denied episode clinical metadata"; plans
        // suite: "Admin status never grants clinical reading or approval";
        // documents suite: admin document read is 403.
        clinical: 'denial',
        // Dashboard suite: an administrator cannot browse clinical queues (403).
        dashboard: 'denial',
        // constants.js: admin holds audit.read + retention.manage + metrics.read.
        administrative: 'served',
        // metrics suite: admin 200; aggregates only, never clinical content.
        operational: 'aggregate',
      },
    },
    {
      label: 'deactivated membership',
      agent: ctx.deactivatedCtx.a,
      expect: denial,
    },
    {
      label: 'disabled account',
      agent: ctx.disabledCtx.a,
      expect: denial,
    },
  ];
}

function isDenial(status) {
  return status === 401 || status === 403 || status === 404;
}

// The safe error envelope contract (control #9): { error: { code, message } }
// with a stable machine code and a safe user-facing message.
function assertErrorEnvelope(res, label) {
  const body = res.body || {};
  assert.ok(body.error, `${label}: response must carry an error envelope, got ${JSON.stringify(body)}`);
  assert.match(
    String(body.error.code || ''),
    /^[A-Z][A-Z0-9_]*$/,
    `${label}: error code must be a stable machine code, got ${JSON.stringify(body.error.code)}`
  );
  assert.ok(
    typeof body.error.message === 'string' && body.error.message.length > 0,
    `${label}: error message must be a safe user-facing string`
  );
}

function assertNoClinicalLeak(res, label) {
  const raw = JSON.stringify(res.body);
  assert.ok(
    !raw.includes(PATIENT_NAME),
    `${label} leaked the patient name: ${raw.slice(0, 400)}`
  );
}

test('only the entitled actor is served: the full role/tenant matrix, observed', async () => {
  const ctx = await setup();
  const rows = endpoints(ctx);
  const actors = actorMatrix(ctx);

  const observed = [];
  for (const actor of actors) {
    for (const endpoint of rows) {
      const expectation = actor.expect[endpoint.kind];
      const label = `${actor.label} | ${endpoint.name}`;
      // eslint-disable-next-line no-await-in-loop
      const agent = actor.agent || harness.agent(app);
      // eslint-disable-next-line no-await-in-loop
      const res = await agent.get(endpoint.path);
      observed.push(`${label} -> ${res.status} (expected ${expectation})`);

      if (res.status >= 500) {
        assert.fail(`${label} produced a server error: ${JSON.stringify(res.body)}`);
      }

      if (expectation === 'denial') {
        assert.ok(
          isDenial(res.status),
          `${label} must be refused, got ${res.status} ${JSON.stringify(res.body)}`
        );
        assertErrorEnvelope(res, label);
        assertNoClinicalLeak(res, label);
      } else if (expectation === 'scoped-zero') {
        assert.equal(res.status, 200, `${label}: dashboard must open but stay empty: ${JSON.stringify(res.body)}`);
        assert.equal(
          res.body.summary.counts.total,
          0,
          `${label} must see none of another care team's work`
        );
        assertNoClinicalLeak(res, label);
      } else if (expectation === 'aggregate') {
        // Operational surfaces are permission-gated but self/aggregate scoped:
        // they may open for staff and admin, yet must never carry clinical rows.
        assert.equal(res.status, 200, `${label} must read operational aggregates: ${JSON.stringify(res.body)}`);
        assertNoClinicalLeak(res, label);
      } else if (expectation === 'served') {
        assert.equal(res.status, 200, `${label} is entitled to this surface: ${JSON.stringify(res.body)}`);
      } else {
        assert.fail(`${label}: unknown expectation ${expectation}`);
      }
    }
  }

  process.stdout.write(`\nobserved access matrix\n${observed.map((line) => `  ${line}`).join('\n')}\n`);
});

test('the administrator is refused every clinical write while administrative work stays open', async () => {
  const ctx = await setup();

  // Episode creation needs episode.manage (episodes suite asserts admin 403).
  const episode = await ctx.adminCtx.a
    .post('/api/episodes')
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({ patientId: ctx.patient.id, dischargeDate: '2026-09-01', dischargeTimezone: 'UTC' });
  assert.equal(episode.status, 403, JSON.stringify(episode.body));
  assertErrorEnvelope(episode, 'admin create episode');

  // Patient creation and patient browsing both sit behind staff permissions the
  // administrator does not hold (constants.js: admin has no patient.*).
  const patient = await ctx.adminCtx.a
    .post('/api/patients')
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({ fullName: 'Synthetic Intruder Patient' });
  assert.equal(patient.status, 403, JSON.stringify(patient.body));

  const list = await ctx.adminCtx.a.get('/api/patients?limit=1');
  assert.equal(list.status, 403, JSON.stringify(list.body));

  // A REAL draft plan: the administrator can neither read it nor drive it.
  const plan = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/plans`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ title: 'QA matrix draft' });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const planId = plan.body.plan.id;

  const read = await ctx.adminCtx.a.get(`/api/episodes/${ctx.episode.id}/plans/${planId}`);
  assert.equal(read.status, 403, JSON.stringify(read.body));
  assert.match(read.body.error.message, /Administrators cannot read/i);

  // Submitting the draft is a clinical workflow transition: refused, and the
  // plan must NOT have moved (no corrupt state from an unauthorized actor).
  const revision = await ctx.coordCtx.a.get(`/api/episodes/${ctx.episode.id}/plans/${planId}`);
  assert.equal(revision.status, 200, JSON.stringify(revision.body));
  const submit = await ctx.adminCtx.a
    .post(`/api/episodes/${ctx.episode.id}/plans/${planId}/submit`)
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({ expectedRevision: revision.body.plan.revision });
  assert.ok(
    isDenial(submit.status),
    `administrator must not submit a plan for review (got ${submit.status} ${JSON.stringify(submit.body)})`
  );
  assertErrorEnvelope(submit, 'admin submit plan');

  const after = await ctx.coordCtx.a.get(`/api/episodes/${ctx.episode.id}/plans/${planId}`);
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.equal(
    after.body.plan.state,
    'draft',
    'an unauthorized actor must not be able to move a plan between states'
  );

  // Positive control: the same administrative surface the admin DOES hold stays
  // open, so the denials above are permission-based, not a broken account.
  const categories = await ctx.adminCtx.a.get('/api/retention/categories');
  assert.equal(categories.status, 200, JSON.stringify(categories.body));
});

test('a revoked assignment takes effect on the very next request', async () => {
  const ctx = await setup();

  // The creator is the episode's first care coordinator, so they start served.
  const before = await ctx.coordCtx.a.get(`/api/episodes/${ctx.episode.id}`);
  assert.equal(before.status, 200, JSON.stringify(before.body));

  // A second coordinator joins the team (the assigned coordinator administers
  // the roster, exactly as the documents suite does).
  const added = await ctx.coordCtx.a
    .post(`/api/episodes/${ctx.episode.id}/team`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({ memberUserId: ctx.outsider.id, responsibility: 'care_coordinator' });
  assert.equal(added.status, 201, JSON.stringify(added.body));

  // The newcomer is served now - reads AND the assignment-scoped episode list.
  assert.equal((await ctx.outsiderCtx.a.get(`/api/episodes/${ctx.episode.id}`)).status, 200);
  const listBefore = await ctx.outsiderCtx.a.get('/api/episodes?limit=50');
  assert.equal(listBefore.status, 200, JSON.stringify(listBefore.body));
  assert.ok(
    listBefore.body.items.some((item) => item.id === ctx.episode.id),
    'the assigned staff member sees the episode in their list'
  );
  const documentsBefore = await ctx.outsiderCtx.a.get(`/api/episodes/${ctx.episode.id}/documents`);
  assert.equal(documentsBefore.status, 200, JSON.stringify(documentsBefore.body));

  // Revoke the newcomer's interval using the other assigned coordinator.
  const team = await ctx.coordCtx.a.get(`/api/episodes/${ctx.episode.id}/team`);
  assert.equal(team.status, 200, JSON.stringify(team.body));
  assert.ok(Array.isArray(team.body.items), `roster must be an items array: ${JSON.stringify(team.body)}`);
  const row = team.body.items.find(
    (item) => item.memberUserId === ctx.outsider.id && item.status === 'active'
  );
  assert.ok(row, 'the newcomer holds an active interval on the roster');

  const revoked = await ctx.coordCtx.a
    .delete(`/api/episodes/${ctx.episode.id}/team/${row.id}`)
    .set('X-CSRF-Token', ctx.coordCtx.csrf);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal(revoked.body.assignment.status, 'revoked');

  // The SAME session, with no re-login, loses every assignment-scoped surface.
  const after = await ctx.outsiderCtx.a.get(`/api/episodes/${ctx.episode.id}`);
  assert.ok(
    isDenial(after.status),
    `a revoked assignment must lose access immediately, got ${after.status}`
  );
  assertErrorEnvelope(after, 'revoked episode read');

  const documents = await ctx.outsiderCtx.a.get(`/api/episodes/${ctx.episode.id}/documents`);
  assert.ok(isDenial(documents.status), `documents must follow the assignment, got ${documents.status}`);

  const plans = await ctx.outsiderCtx.a.get(`/api/episodes/${ctx.episode.id}/plans`);
  assert.ok(isDenial(plans.status), `plans must follow the assignment, got ${plans.status}`);

  const listAfter = await ctx.outsiderCtx.a.get('/api/episodes?limit=50');
  assert.equal(listAfter.status, 200, JSON.stringify(listAfter.body));
  assert.ok(
    !listAfter.body.items.some((item) => item.id === ctx.episode.id),
    'the revoked episode must leave the scoped list at once'
  );

  // The original creator is untouched by somebody else's revocation.
  assert.equal((await ctx.coordCtx.a.get(`/api/episodes/${ctx.episode.id}`)).status, 200);
});
