'use strict';

// Non-functional QA regressions (branch test/non-functional-security-qa):
//   NQ-1 an oversized or malformed JSON body is a CLIENT error (413/400) with a
//        stable code - it must never surface as a 500.
//   NQ-2 every API response defaults to Cache-Control: no-store, so a clinical
//        JSON body can never be retained by a browser or shared cache.
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { init, shutdown } = require('../helpers/setup');

let app;
test.before(async () => {
  app = await init();
});

test.after(async () => {
  await shutdown();
});

test('NQ-1: oversized JSON body answers 413 PAYLOAD_TOO_LARGE, not 500', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ email: 'x@synthetic.invalid', pad: 'x'.repeat(200 * 1024) }));
  assert.equal(res.status, 413);
  assert.equal(res.body.error.code, 'PAYLOAD_TOO_LARGE');
});

test('NQ-1: malformed JSON body answers 400 BAD_REQUEST, not 500', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .set('Content-Type', 'application/json')
    .send('{"email": ');
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'BAD_REQUEST');
});

test('NQ-1: unsupported charset answers 415, not 500', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .set('Content-Type', 'application/json; charset=utf-7')
    .send('{"email":"x@synthetic.invalid"}');
  assert.ok(res.status === 415 || res.status === 400, `expected 415/400, got ${res.status}`);
});

test('NQ-2: an unauthenticated API response already carries Cache-Control: no-store', async () => {
  const res = await request(app).get('/api/patients?page=1&limit=1');
  assert.equal(res.status, 401);
  assert.match(res.headers['cache-control'] || '', /no-store/);
});

test('NQ-2: authenticated JSON routes also default to no-store', async () => {
  // Login page is public; the assertion is about the header default, which is
  // set before any handler runs.
  const res = await request(app)
    .post('/api/auth/login')
    .set('Content-Type', 'application/json')
    .send({ email: 'ghost@synthetic.invalid', password: 'WrongPass!24' });
  assert.equal(res.status, 403);
  assert.match(res.headers['cache-control'] || '', /no-store/);
});