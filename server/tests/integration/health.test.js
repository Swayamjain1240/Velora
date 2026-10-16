'use strict';

// Part 10: liveness, readiness and the deployment-shape settings a probe or an
// operator depends on.
//
// The assertions this file turns on: liveness never depends on a dependency and
// never needs a session, readiness FAILS CLOSED (503) while draining or when
// encrypted storage is unusable and explicitly names which dependency is at
// fault, no readiness payload discloses a path or a host, and `trust proxy` is
// the validated environment's decision rather than a hardcoded hop count.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Set BEFORE the harness loads the environment: a deployment behind two trusted
// proxy hops must resolve to exactly that, and the app must read it from config.
process.env.TRUST_PROXY = 'true';
process.env.PROXY_HOPS = '2';

const harness = require('../helpers/setup');
const documentStorage = require('../../src/services/documentStorage');
const readiness = require('../../src/services/readiness');

let app;

test.before(async () => {
  app = await harness.init();
});

test.after(async () => {
  readiness.__resetForTest();
  await harness.shutdown();
});

test('liveness answers without a session and discloses no configuration', async () => {
  const res = await harness.agent(app).get('/api/health');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.equal(res.body.status, 'healthy');
  assert.equal(typeof res.body.uptimeSeconds, 'number');
  assert.equal(res.headers['cache-control'], 'no-store');
  // Every response can be correlated with its server-side log line.
  assert.match(res.headers['x-request-id'], /^[0-9a-f-]{36}$/);

  const payload = JSON.stringify(res.body);
  assert.ok(!payload.includes(process.env.DOCUMENT_STORAGE_ROOT), 'must not disclose the storage root');
  assert.ok(!payload.includes('27019'), 'must not disclose the database endpoint');
  assert.ok(!payload.includes('replicaSet'), 'must not disclose the database options');
  assert.equal(res.body.checks, undefined, 'liveness reports no dependency detail');
});

test('readiness reports each dependency it actually probed', async () => {
  await documentStorage.ensureRoot();
  const res = await harness.agent(app).get('/api/ready');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.checks, { database: 'ok', storage: 'ok' });
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('readiness fails closed while draining and recovers afterwards, and liveness is unaffected', async () => {
  readiness.markDraining();
  try {
    const ready = await harness.agent(app).get('/api/ready');
    assert.equal(ready.status, 503, JSON.stringify(ready.body));
    assert.equal(ready.body.ok, false);
    assert.equal(ready.body.status, 'draining');
    assert.equal(ready.body.checks.draining, true);

    // A draining process is still ALIVE: an orchestrator must be able to tell
    // "leaving rotation" apart from "needs a restart".
    const live = await harness.agent(app).get('/api/health');
    assert.equal(live.status, 200);
  } finally {
    readiness.__resetForTest();
  }

  const recovered = await harness.agent(app).get('/api/ready');
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(recovered.body.status, 'ready');
});

test('readiness fails closed when the encrypted storage root is unusable, and says which dependency', async () => {
  await documentStorage.ensureRoot();
  const root = process.env.DOCUMENT_STORAGE_ROOT;
  const moved = path.join(path.dirname(root), `${path.basename(root)}-moved`);
  fs.rmSync(moved, { recursive: true, force: true });
  fs.renameSync(root, moved);
  try {
    const res = await harness.agent(app).get('/api/ready');
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.body.ok, false);
    assert.equal(res.body.checks.storage, 'missing');
    assert.equal(res.body.checks.database, 'ok');
    assert.ok(
      !JSON.stringify(res.body).includes(root),
      'a failing probe must not disclose the path it failed on'
    );
  } finally {
    fs.renameSync(moved, root);
  }

  const restored = await harness.agent(app).get('/api/ready');
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
});

test('trust proxy is the validated environment decision, not a hardcoded hop', () => {
  assert.equal(app.get('trust proxy'), 2);
  assert.equal(process.env.PROXY_HOPS, '2');
});
