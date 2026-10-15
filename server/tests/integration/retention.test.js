'use strict';

// Part 9 exit gate: retention categories, dry run, apply and holds.
//
// The assertions the part turns on: categories are configurable and default
// safely; a dry run changes nothing; apply requires an operator and a reason and
// is idempotent; clinical categories are report-only; a hold freezes a category;
// and only an administrator may configure or apply.
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

async function setup() {
  const a = await harness.makeClinic({ codePrefix: 'RETA' });
  const ctx = { clinic: a.clinic };
  ctx.adminCtx = await harness.signInStaff(app, a.admin.user.email);
  const coord = await harness.makeMember(a.clinic, { roleKey: 'care_coordinator' });
  ctx.coord = coord;
  ctx.coordCtx = await harness.signInStaff(app, coord.user.email);
  return ctx;
}

// An expired session belonging to a member of the clinic.
async function oldSession(ctx, daysAgo) {
  return harness.models.Session.create({
    user: ctx.coord.user.id,
    tokenHash: `hash-${Math.random()}`,
    csrfSecret: 'x',
    state: 'active',
    expiresAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
  });
}

test('categories come from the documented catalog with a report-only clinical set', async () => {
  const ctx = await setup();
  const res = await ctx.adminCtx.a.get('/api/retention/categories').set('X-CSRF-Token', ctx.adminCtx.csrf);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const byKey = new Map(res.body.categories.map((c) => [c.key, c]));
  assert.equal(byKey.get('sessions_tokens').retainDays, 30);
  assert.equal(byKey.get('documents').reportOnly, true);
  assert.equal(byKey.get('historical_records').reportOnly, true);

  // A coordinator may not configure retention.
  const denied = await ctx.coordCtx.a.get('/api/retention/categories').set('X-CSRF-Token', ctx.coordCtx.csrf);
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
});

test('a category can be reconfigured and the override is reflected', async () => {
  const ctx = await setup();
  const patched = await ctx.adminCtx.a
    .patch('/api/retention/categories/sessions_tokens')
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({ retainDays: 3 });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  const row = patched.body.categories.find((c) => c.key === 'sessions_tokens');
  assert.equal(row.retainDays, 3);
  assert.equal(row.overridden, true);
});

test('a dry run reports eligible items and changes nothing', async () => {
  const ctx = await setup();
  const expired = await oldSession(ctx, 90);

  const dry = await ctx.adminCtx.a.post('/api/retention/dry-run').set('X-CSRF-Token', ctx.adminCtx.csrf).send({});
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.run.mode, 'dry_run');
  const sessions = dry.body.plan.find((c) => c.category === 'sessions_tokens');
  assert.equal(sessions.eligible, 1);

  const remaining = await harness.models.Session.findById(expired._id).lean();
  assert.ok(remaining, 'a dry run must not delete anything');

  // A dry run is a REPORT, so it is repeatable: each one appends its own run
  // record. An empty idempotency key would store a null, and the second run
  // would collide on the `(clinic, idempotencyKey)` unique index - a read-only
  // report refused with `409` because someone had reported before.
  const second = await ctx.adminCtx.a
    .post('/api/retention/dry-run')
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({});
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.notEqual(second.body.run.id, dry.body.run.id, 'each report is its own run');
  assert.equal(second.body.run.mode, 'dry_run');

  const runs = await harness.models.RetentionRun.find({ mode: 'dry_run' }).lean();
  assert.equal(runs.length, 2, 'both reports are recorded');
  const keys = runs.map((r) => r.idempotencyKey);
  assert.ok(keys.every((k) => typeof k === 'string' && k.length > 8), JSON.stringify(keys));
  assert.equal(new Set(keys).size, 2, 'no two reports share an idempotency key');
  assert.ok(
    keys.every((k) => k.startsWith('dry-run:')),
    'a report key is visibly a report rather than a caller request id'
  );
});

test('apply requires an operator and reason, is audited, and is idempotent', async () => {
  const ctx = await setup();
  const expired = await oldSession(ctx, 90);

  const missingOperator = await ctx.adminCtx.a
    .post('/api/retention/apply')
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({ reason: 'Routine retention sweep.', clientRequestId: 'ret-sweep-1', confirm: true });
  assert.equal(missingOperator.status, 400, JSON.stringify(missingOperator.body));

  const applied = await ctx.adminCtx.a
    .post('/api/retention/apply')
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({
      operator: 'Synthetic Admin',
      reason: 'Routine retention sweep per clinic policy.',
      categories: ['sessions_tokens'],
      clientRequestId: 'ret-sweep-1',
      confirm: true,
    });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.idempotent, false);
  assert.equal(applied.body.affected.sessions_tokens, 1);
  assert.equal(await harness.models.Session.findById(expired._id).lean(), null);

  const again = await ctx.adminCtx.a
    .post('/api/retention/apply')
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({
      operator: 'Synthetic Admin',
      reason: 'Routine retention sweep per clinic policy.',
      categories: ['sessions_tokens'],
      clientRequestId: 'ret-sweep-1',
      confirm: true,
    });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.idempotent, true);
  assert.equal(again.body.run.id, applied.body.run.id);

  const auditRow = await harness.models.AuditEvent.findOne({ action: 'retention.applied' }).lean();
  assert.ok(auditRow);
  assert.equal(auditRow.category, 'retention');
});

test('a coordinator cannot apply retention', async () => {
  const ctx = await setup();
  const denied = await ctx.coordCtx.a
    .post('/api/retention/apply')
    .set('X-CSRF-Token', ctx.coordCtx.csrf)
    .send({
      operator: 'Coordinator',
      reason: 'Trying to apply retention without the permission.',
      clientRequestId: 'ret-denied-1',
      confirm: true,
    });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
});

test('clinical categories are report-only and never deleted', async () => {
  const ctx = await setup();
  // An old document row: report-only means it is enumerated, never removed.
  await harness.models.RecoveryEpisode.create({
    clinic: ctx.clinic.id,
    patient: new (require('mongoose').Types.ObjectId)(),
    reference: 'EP-RET1',
    dischargeDate: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
    dischargeTimezone: 'UTC',
    status: 'closed',
    closureState: 'closed',
    createdBy: ctx.coord.user.id,
    updatedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
  });

  const res = await ctx.adminCtx.a
    .post('/api/retention/apply')
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({
      operator: 'Synthetic Admin',
      reason: 'Routine retention sweep covering historical records.',
      categories: ['historical_records'],
      clientRequestId: 'ret-reportonly-1',
      confirm: true,
    });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const row = res.body.run.categories.find((c) => c.category === 'historical_records');
  assert.equal(row.reportOnly, true);
  assert.equal(row.affected, 0);
  assert.equal(await harness.models.RecoveryEpisode.countDocuments({ reference: 'EP-RET1' }), 1);
});

test('a hold freezes its category until it is explicitly released', async () => {
  const ctx = await setup();
  const expired = await oldSession(ctx, 90);

  const hold = await ctx.adminCtx.a
    .post('/api/retention/holds')
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({ scope: 'category', category: 'sessions_tokens', reason: 'Forensic review in progress.' });
  assert.equal(hold.status, 201, JSON.stringify(hold.body));

  const held = await ctx.adminCtx.a
    .post('/api/retention/apply')
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({
      operator: 'Synthetic Admin',
      reason: 'Attempting a sweep while a hold is active.',
      categories: ['sessions_tokens'],
      clientRequestId: 'ret-held-1',
      confirm: true,
    });
  assert.equal(held.status, 200, JSON.stringify(held.body));
  assert.equal(held.body.affected.sessions_tokens, 0);
  assert.ok(await harness.models.Session.findById(expired._id).lean(), 'a held category must not be touched');

  const released = await ctx.adminCtx.a
    .post(`/api/retention/holds/${hold.body.hold.id}/release`)
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({ reason: 'Forensic review finished.' });
  assert.equal(released.status, 200, JSON.stringify(released.body));

  const swept = await ctx.adminCtx.a
    .post('/api/retention/apply')
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({
      operator: 'Synthetic Admin',
      reason: 'Sweep after the hold was released.',
      categories: ['sessions_tokens'],
      clientRequestId: 'ret-after-hold-1',
      confirm: true,
    });
  assert.equal(swept.status, 200, JSON.stringify(swept.body));
  assert.equal(swept.body.affected.sessions_tokens, 1);
});

test('a partial failure leaves a defensible run and can be retried', async () => {
  const ctx = await setup();
  const expired = await oldSession(ctx, 90);

  // A category whose apply cannot run (delivery attempts are append-only) marks
  // the run and is retried with a fresh idempotency key.
  const first = await ctx.adminCtx.a
    .post('/api/retention/apply')
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({
      operator: 'Synthetic Admin',
      reason: 'Sweep of operational logs across the window.',
      categories: ['operational_logs'],
      clientRequestId: 'ret-logs-1',
      confirm: true,
    });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(first.body.run.id);

  // The retried category still removes the expired session.
  const retry = await ctx.adminCtx.a
    .post('/api/retention/apply')
    .set('X-CSRF-Token', ctx.adminCtx.csrf)
    .send({
      operator: 'Synthetic Admin',
      reason: 'Retry after reviewing the first run.',
      categories: ['sessions_tokens'],
      clientRequestId: 'ret-logs-2',
      confirm: true,
    });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(await harness.models.Session.findById(expired._id).lean(), null);
});
