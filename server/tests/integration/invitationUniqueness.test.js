'use strict';

// Non-functional QA regression (NQ-3): at most ONE active staff invitation per
// clinic+email. Before the fix, 8 parallel POSTs left 8 live tokens for the same
// person; now the service answers a friendly 409 and the partial unique index is
// the atomic backstop. Accepting/revoking releases the address, so re-inviting
// still works.
const test = require('node:test');
const assert = require('node:assert');
const harness = require('../helpers/setup');

let app;
const PASSWORD = 'SyntheticTestPass!24';

test.before(async () => {
  app = await harness.init();
});
test.after(async () => {
  await harness.shutdown();
});
test.beforeEach(async () => {
  await harness.resetDb();
});

async function adminAgent(email) {
  const a = harness.agent(app);
  const login = await a.post('/api/auth/login').send({ email, password: PASSWORD });
  const csrf = harness.csrfFrom(login);
  await harness.enrollMfa(a, csrf, email);
  return { a, csrf };
}

test('NQ-3: a second active invitation for the same email is refused with 409', async () => {
  const { admin } = await harness.makeClinic({});
  const { a, csrf } = await adminAgent(admin.user.email);
  const email = 'duplicate.invite@synthetic.invalid';

  const first = await a
    .post('/api/staff/invitations')
    .set('X-CSRF-Token', csrf)
    .send({ email, roleKey: 'care_coordinator' });
  assert.strictEqual(first.status, 201, JSON.stringify(first.body));

  const second = await a
    .post('/api/staff/invitations')
    .set('X-CSRF-Token', csrf)
    .send({ email, roleKey: 'care_coordinator' });
  assert.strictEqual(second.status, 409, JSON.stringify(second.body));
  assert.match(second.body.error.message, /already exists/i);

  const { Invitation } = harness.models;
  const active = await Invitation.countDocuments({ email, acceptedAt: null, revokedAt: null });
  assert.strictEqual(active, 1);
});

test('NQ-3: parallel invitations for one email leave exactly ONE active token', async () => {
  const { admin } = await harness.makeClinic({});
  const { a, csrf } = await adminAgent(admin.user.email);
  const email = 'parallel.invite@synthetic.invalid';

  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      a.post('/api/staff/invitations').set('X-CSRF-Token', csrf).send({ email, roleKey: 'care_coordinator' })
    )
  );
  const created = results.filter((r) => r.status === 201).length;
  const conflicts = results.filter((r) => r.status === 409).length;
  const serverErrors = results.filter((r) => r.status >= 500).length;

  assert.strictEqual(created, 1, JSON.stringify(results.map((r) => r.status)));
  assert.strictEqual(conflicts, 7);
  assert.strictEqual(serverErrors, 0);

  const { Invitation } = harness.models;
  const active = await Invitation.countDocuments({ email, acceptedAt: null, revokedAt: null });
  assert.strictEqual(active, 1);
});

test('NQ-3: revoking an invitation frees the address for a new one', async () => {
  const { admin } = await harness.makeClinic({});
  const { a, csrf } = await adminAgent(admin.user.email);
  const email = 'revoke.then.invite@synthetic.invalid';

  const first = await a
    .post('/api/staff/invitations')
    .set('X-CSRF-Token', csrf)
    .send({ email, roleKey: 'care_coordinator' });
  assert.strictEqual(first.status, 201);

  const revoked = await a
    .delete(`/api/staff/invitations/${first.body.invitation.id}`)
    .set('X-CSRF-Token', csrf);
  assert.strictEqual(revoked.status, 200, JSON.stringify(revoked.body));

  const again = await a
    .post('/api/staff/invitations')
    .set('X-CSRF-Token', csrf)
    .send({ email, roleKey: 'care_coordinator' });
  assert.strictEqual(again.status, 201, JSON.stringify(again.body));

  const { Invitation } = harness.models;
  const active = await Invitation.countDocuments({ email, acceptedAt: null, revokedAt: null });
  assert.strictEqual(active, 1);
});