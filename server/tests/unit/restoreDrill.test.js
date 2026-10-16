'use strict';

// Part 10: the restore drill's decision logic.
//
// The assertions this file turns on: connection strings are re-pointed at a drill
// database without losing the replica set or TLS options, and an index is
// recreated with EVERY option that decides which documents it accepts - a partial
// unique index restored as a full one rejects valid data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  canonical,
  dbNameOf,
  withDbName,
  indexOptions,
} = require('../../scripts/restore-drill');

// Connection strings here are assembled from parts on purpose: a source file must
// never contain a complete credential-shaped URI, even a synthetic one, because a
// secret scanner cannot tell a fixture from a leak.
const USERINFO = ['demo', 'placeholder'].join(':');

const withCredentials = (hostAndDb, query = '') =>
  `mongodb://${USERINFO}@${hostAndDb}${query}`;

const sharded = (hostAndDb, query = '') => `mongodb+srv://${USERINFO}@${hostAndDb}${query}`;

test('the database name is read from a connection string with or without options', () => {
  assert.equal(dbNameOf('mongodb://127.0.0.1:27019/velora?replicaSet=rs0'), 'velora');
  assert.equal(dbNameOf(withCredentials('host:27017/velora_test')), 'velora_test');
  assert.equal(dbNameOf(sharded('host/velora', '?retryWrites=true')), 'velora');
  assert.equal(dbNameOf('mongodb://127.0.0.1:27017'), '');
});

test('re-pointing a connection string keeps the host and every option', () => {
  assert.equal(
    withDbName('mongodb://127.0.0.1:27019/velora?replicaSet=rs0', 'velora_drill'),
    'mongodb://127.0.0.1:27019/velora_drill?replicaSet=rs0'
  );
  // Credentials and the option string survive re-pointing: a restored drill must
  // connect exactly the way the application would.
  assert.equal(
    withDbName(sharded('cluster.example/velora', '?retryWrites=true&w=majority'), 'drill'),
    sharded('cluster.example/drill', '?retryWrites=true&w=majority')
  );
  assert.ok(withDbName(withCredentials('host:27017/velora'), 'drill').includes(USERINFO));
  assert.equal(withDbName('mongodb://127.0.0.1:27019/velora', 'drill'), 'mongodb://127.0.0.1:27019/drill');
});

test('index options are recreated faithfully, including the partial filter', () => {
  const source = {
    name: 'clinic_1_patient_1_caregiverUser_1',
    key: { clinic: 1, patient: 1, caregiverUser: 1 },
    unique: true,
    partialFilterExpression: { status: 'active' },
  };
  const options = indexOptions(source);

  assert.equal(options.unique, true);
  // The option that decides which rows may collide: losing it turns a partial
  // unique index into a full one and the restore fails on legitimately repeated
  // (clinic, patient, caregiver) pairs from revoked grants.
  assert.deepEqual(options.partialFilterExpression, { status: 'active' });
  assert.equal(options.sparse, undefined);
  assert.equal(options.expireAfterSeconds, undefined);
});

test('a TTL index keeps its expiry and a plain index keeps only its name', () => {
  const ttl = indexOptions({ name: 'expires_1', key: { expiresAt: 1 }, expireAfterSeconds: 0 });
  assert.equal(ttl.expireAfterSeconds, 0);
  assert.equal(ttl.unique, undefined);

  const plain = indexOptions({ name: 'createdAt_-1', key: { createdAt: -1 } });
  assert.deepEqual(plain, { name: 'createdAt_-1' });
});

test('the content checksum is deterministic and order-independent of key insertion', () => {
  const a = canonical({ b: 1, a: [{ y: 2, x: 1 }] });
  const b = canonical({ a: [{ x: 1, y: 2 }], b: 1 });
  assert.equal(a, b);
  assert.notEqual(canonical({ a: 1 }), canonical({ a: 2 }));
  assert.equal(canonical(new Date('2026-01-02T03:04:05.000Z')), '"2026-01-02T03:04:05.000Z"');
  assert.equal(canonical(Buffer.from([1, 2])), '"buf:AQI="');
});
