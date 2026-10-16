'use strict';

// QA API contract sweep: EVERY registered endpoint, exercised anonymously.
//
// A route list in a document is a claim; this test asks the running app. It walks
// the real Express stack, then for every route outside the small public set makes
// one anonymous request and requires that the request is refused with the
// standard safe envelope - never served, never leaked. The public set is pinned
// exactly, so adding a new unauthenticated route fails this test until it is
// deliberately listed.
//
// It also asserts the inventory itself is non-trivial: a walker that silently
// finds nothing must not be able to pass this file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const harness = require('../helpers/setup');
const { collectRoutes } = require('../../scripts/qa-inventory');

let app;

test.before(async () => {
  app = await harness.init();
});
test.beforeEach(async () => {
  // This file asserts "nothing was written" counts, so it must own a clean
  // baseline rather than inheriting another suite's rows from the shared
  // test database.
  await harness.resetDb();
});
test.after(async () => {
  await harness.shutdown();
});

// The public surface, pinned: route path -> the status an anonymous request may
// receive. Probes answer 200; body-carrying endpoints reject the empty body with
// a validation 400 rather than an authentication 401, which is what proves they
// are deliberately reachable.
const PUBLIC = new Map([
  ['GET /api/health', [200]],
  ['GET /api/ready', [200, 503]],
  ['POST /api/auth/login', [400, 401, 429]],
  ['POST /api/auth/logout', [200, 204, 400]],
  ['GET /api/auth/status', [200]],
  ['POST /api/auth/accept-invitation', [400, 401, 403, 429]],
  ['POST /api/auth/password/forgot', [400, 429]],
  ['POST /api/auth/password/reset', [400, 429]],
  ['POST /api/auth/mfa/verify', [400, 401]],
  ['POST /api/auth/mfa/enroll/setup', [401]],
  ['POST /api/auth/mfa/enroll/verify', [400, 401]],
  ['POST /api/access/caregiver-invitation', [400, 401, 429]],
  ['POST /api/access/patient-activation', [400, 401, 429]],
]);

const OBJECT_ID = '64b7f0c2f1a2b3c4d5e6f701';

// A concrete URL for a declared path: ids get a well-formed ObjectId (so a
// validation layer cannot answer before the authorization layer), any other
// parameter gets a synthetic token.
function concrete(routePath) {
  return routePath
    .replace(/:[A-Za-z0-9_]*Id\b/g, OBJECT_ID)
    .replace(/:[A-Za-z0-9_]+/g, 'synthetic-token');
}

// Values/keys that must never appear in an anonymous response body.
const FORBIDDEN_IN_BODY = [
  'password',
  'passwordHash',
  'secretEnc',
  'storageKey',
  'tokenHash',
  'csrfSecret',
  'recoveryCode',
  'connectionString',
  'mongodb://',
  'replicaSet',
  'stack',
];

function assertSafeRefusal(res, label) {
  assert.equal(res.status, 401, `${label} answered ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.error.code, 'UNAUTHORIZED', `${label} envelope code`);
  assert.equal(typeof res.body.error.message, 'string');
  assert.match(res.headers['x-request-id'], /^[0-9a-f-]{36}$/, `${label} correlation id`);
  const payload = JSON.stringify(res.body);
  for (const forbidden of FORBIDDEN_IN_BODY) {
    assert.ok(
      !payload.toLowerCase().includes(forbidden.toLowerCase()),
      `${label} leaked "${forbidden}": ${payload}`
    );
  }
  assert.equal(res.body.data, undefined, `${label} must not return a data payload`);
}

test('the route inventory is real: a substantive number of routes is walked', () => {
  const routes = collectRoutes(app._router.stack);
  assert.ok(routes.length >= 150, `expected >= 150 routes, walked ${routes.length}`);
  // Every path is absolute and method-bearing.
  for (const route of routes) {
    assert.match(route.path, /^\/api\//, `route path must be absolute: ${route.path}`);
    assert.match(route.method, /^[A-Z]+$/);
  }
});

test('every endpoint outside the pinned public set refuses an anonymous caller', async () => {
  const routes = collectRoutes(app._router.stack).filter((route) => !route.public);
  assert.ok(routes.length >= 150, `expected >= 150 private routes, found ${routes.length}`);
  const failures = [];
  const agent = harness.agent(app);

  for (const route of routes) {
    const url = concrete(route.path);
    const label = `${route.method} ${route.path}`;
    let request = agent[route.method.toLowerCase()](url);
    if (route.method === 'GET') request = request.query({ page: 1, limit: 25 });
    // eslint-disable-next-line no-await-in-loop
    const res = await request.send(route.method === 'GET' ? undefined : {});
    try {
      assertSafeRefusal(res, label);
    } catch (err) {
      failures.push(`${label} -> ${res.status} ${JSON.stringify(res.body)} (${err.message})`);
    }
  }

  assert.deepEqual(failures, [], `routes that did not refuse an anonymous caller:\n${failures.join('\n')}`);
});

test('the public surface is exactly the pinned set, and each route is reachable anonymously', async () => {
  const routes = collectRoutes(app._router.stack);
  const publicRoutes = routes.filter((route) => route.public).map((route) => `${route.method} ${route.path}`).sort();
  assert.deepEqual(publicRoutes, [...PUBLIC.keys()].sort(), 'the public surface changed');

  const agent = harness.agent(app);
  for (const route of routes.filter((r) => r.public)) {
    const label = `${route.method} ${route.path}`;
    let request = agent[route.method.toLowerCase()](concrete(route.path));
    // eslint-disable-next-line no-await-in-loop
    const res = await request.send(route.method === 'GET' ? undefined : {});
    const allowed = PUBLIC.get(label) || [];
    assert.ok(allowed.includes(res.status), `${label} answered ${res.status}, expected one of ${allowed}`);
    const payload = JSON.stringify(res.body);
    for (const forbidden of ['passwordHash', 'secretEnc', 'storageKey', 'mongodb://', 'stack']) {
      assert.ok(!payload.includes(forbidden), `${label} leaked "${forbidden}"`);
    }
  }
});

test('an unauthenticated mutation is refused before any CSRF or handler work', async () => {
  // No session cookie, so CSRF cannot apply: the refusal must be authentication,
  // not a CSRF 403 that would tell a caller a route exists behind a token.
  const res = await harness
    .agent(app)
    .post('/api/patients')
    .send({ fullName: 'Should Not Exist' });
  assert.equal(res.status, 401, JSON.stringify(res.body));
  const rows = await harness.models.PatientProfile.countDocuments({});
  assert.equal(rows, 0, 'an unauthenticated mutation must not write');
});

test('an unknown path is a safe 404 that discloses nothing', async () => {
  const res = await harness.agent(app).get('/api/not-a-real-surface');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'NOT_FOUND');
  assert.ok(!JSON.stringify(res.body).includes('/api/'), 'the 404 must not echo the path');
});

test('an unknown field is rejected rather than ignored, and injection shapes are refused', async () => {
  const agent = harness.agent(app);
  const unknownField = await agent
    .post('/api/auth/login')
    .send({ email: 'synthetic@clinic.example', password: 'Synthetic!24', role: 'admin' });
  assert.equal(unknownField.status, 400, 'unknown properties are rejected by the strict schema');
  assert.equal(unknownField.body.error.code, 'BAD_REQUEST');

  // NoSQL operator injection in a login body never reaches a query.
  const injected = await agent.post('/api/auth/login').send({ email: { $ne: null }, password: { $ne: null } });
  assert.equal(injected.status, 400, JSON.stringify(injected.body));
  assert.ok(!JSON.stringify(injected.body).includes('$ne'));

  // A malformed id on a private route is refused as unauthenticated first: the
  // caller learns nothing about whether the resource exists.
  const malformed = await agent.get('/api/episodes/not-an-object-id');
  assert.equal(malformed.status, 401, JSON.stringify(malformed.body));
});
