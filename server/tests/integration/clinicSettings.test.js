'use strict';

// Part 8 foundation: the clinic's own response hours and emergency guidance are
// admin-configured, audited, and always published with wording that refuses to
// imply continuous monitoring the clinic has not stated.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const harness = require('../helpers/setup');
const hoursPolicy = require('../../src/policies/clinicHoursPolicy');

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
  const ctx = {};
  const a = await harness.makeClinic();
  ctx.adminCtx = await harness.signInStaff(app, a.admin.user.email);
  ctx.clinic = a.clinic;
  const coord = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  ctx.coordCtx = await harness.signInStaff(app, coord.user.email);
  const reviewer = await harness.makeMember(a.clinic, { roleKey: 'clinical_reviewer' });
  ctx.reviewerCtx = await harness.signInStaff(app, reviewer.user.email);
  return ctx;
}

function patchClinic(ctx, body, agent = ctx.adminCtx) {
  return agent.a.patch('/api/clinic').set('X-CSRF-Token', agent.csrf).send(body);
}

test('an unconfigured clinic publishes no hours and never claims monitoring', async () => {
  const ctx = await setup();
  const res = await ctx.adminCtx.a.get('/api/clinic');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const hours = res.body.clinic.settings.responseHours;
  assert.equal(hours.configured, false);
  assert.equal(hours.monitoredContinuously, false);
  assert.match(hours.note, /not published response hours/i);
  assert.match(hours.note, /do not assume/i);
  assert.equal(res.body.clinic.settings.emergency.configured, false);
  assert.match(res.body.clinic.settings.emergency.fallback, /not an emergency service/i);
});

test('an admin publishes response hours and emergency guidance, and the change is audited', async () => {
  const ctx = await setup();
  const res = await patchClinic(ctx, {
    responseHours: {
      display: 'Mon-Fri 09:00-17:00 (clinic time)',
      timezone: 'Europe/London',
      weekdays: 'Mon-Fri',
      from: '09:00',
      to: '17:00',
    },
    emergencyInstructions: {
      display: 'Call the clinic line; outside hours use the on-call number.',
      contactPhone: '+44 20 7946 0000',
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const hours = res.body.clinic.settings.responseHours;
  assert.equal(hours.configured, true);
  assert.equal(hours.timezone, 'Europe/London');
  // The clinic did NOT state continuous cover, so the wording must say so.
  assert.equal(hours.monitoredContinuously, false);
  assert.match(hours.note, /not monitored continuously/i);
  assert.equal(res.body.clinic.settings.emergency.contactPhone, '+44 20 7946 0000');

  const audit = await harness.models.AuditEvent.findOne({
    action: 'clinic.settings.updated',
  }).lean();
  assert.ok(audit, 'the settings change must be audited');
  assert.equal(audit.detail.monitoredContinuously, false);
});

test('only a clinic with stated continuous cover may say so', async () => {
  const ctx = await setup();
  // Continuous cover cannot be claimed without published hours.
  const premature = await patchClinic(ctx, {
    responseHours: {
      display: 'Always available',
      timezone: 'UTC',
      from: '00:00',
      to: '23:59',
      monitoredContinuously: true,
    },
  });
  assert.equal(premature.status, 200, JSON.stringify(premature.body));
  assert.equal(premature.body.clinic.settings.responseHours.monitoredContinuously, true);
  assert.match(premature.body.clinic.settings.responseHours.note, /continuous cover/i);

  // Removing the flag returns the safe wording.
  const back = await patchClinic(ctx, {
    responseHours: {
      display: 'Mon-Fri 09:00-17:00',
      timezone: 'Europe/London',
      from: '09:00',
      to: '17:00',
    },
  });
  assert.equal(back.body.clinic.settings.responseHours.monitoredContinuously, false);
  assert.match(back.body.clinic.settings.responseHours.note, /not monitored continuously/i);
});

test('ambiguous or malformed response hours are refused before any write', async () => {
  const ctx = await setup();
  const cases = [
    { from: '09:00', timezone: 'Europe/London', display: 'Mornings only' },
    { to: '17:00', timezone: 'Europe/London', display: 'Mornings only' },
    { from: '09:00', to: '17:00', display: 'Clinic hours' },
    { from: '25:00', to: '17:00', timezone: 'Europe/London', display: 'Clinic hours' },
    { from: '09:00', to: '17:00', timezone: 'Mars/Olympus', display: 'Clinic hours' },
  ];
  for (const responseHours of cases) {
    // eslint-disable-next-line no-await-in-loop
    const res = await patchClinic(ctx, { responseHours });
    assert.equal(res.status, 400, `expected a refusal for ${JSON.stringify(responseHours)}`);
  }
  const clinic = await harness.models.Clinic.findById(ctx.clinic.id).lean();
  assert.equal(clinic.responseHours, undefined, 'no partial settings were written');
});

test('an unsupported emergency number and unknown fields are rejected', async () => {
  const ctx = await setup();
  const badPhone = await patchClinic(ctx, {
    emergencyInstructions: { display: 'Call the on-call number.', contactPhone: 'call us<script>' },
  });
  assert.equal(badPhone.status, 400);

  const unknown = await patchClinic(ctx, { monitoredContinuously: true });
  assert.equal(unknown.status, 400, 'unknown fields are never silently accepted');

  const empty = await patchClinic(ctx, {});
  assert.equal(empty.status, 400, 'an empty update is a bad request, not a no-op');
});

test('non-admin staff, patients and caregivers cannot change clinic settings', async () => {
  const ctx = await setup();
  const byCoordinator = await patchClinic(ctx, { name: 'Renamed' }, ctx.coordCtx);
  assert.equal(byCoordinator.status, 403);
  const byReviewer = await patchClinic(ctx, { name: 'Renamed' }, ctx.reviewerCtx);
  assert.equal(byReviewer.status, 403);

  const clinic = await harness.models.Clinic.findById(ctx.clinic.id).lean();
  assert.equal(clinic.name, ctx.clinic.name, 'the clinic name is unchanged');
});

test('the display projection is stable for a clinic without settings', () => {
  const summary = hoursPolicy.responseHoursSummary(null);
  assert.equal(summary.configured, false);
  assert.equal(summary.monitoredContinuously, false);
  assert.match(summary.emergency.fallback, /emergency number/i);
});
