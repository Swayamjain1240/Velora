'use strict';

// Unit coverage for the cryptographic helpers. The test environment (and its
// keys) is established by requiring the shared harness first.
const { test } = require('node:test');
const assert = require('node:assert');
const harness = require('../helpers/setup');

const { hashPassword, verifyPassword } = require('../../src/services/passwordService');
const { sealSecret, openSecret, hmac, randomToken } = require('../../src/services/crypto');

test('Argon2id hash round-trips and rejects wrong passwords', async () => {
  const hash = await hashPassword('CorrectHorse!42');
  assert.ok(hash.startsWith('$argon2id$'), 'must be argon2id format');
  assert.ok(!hash.includes('CorrectHorse'), 'hash must not contain plaintext');
  assert.strictEqual(await verifyPassword(hash, 'CorrectHorse!42'), true);
  assert.strictEqual(await verifyPassword(hash, 'wrong'), false);
});

test('verifyPassword tolerates malformed hashes', async () => {
  assert.strictEqual(await verifyPassword('not-a-hash', 'x'), false);
  assert.strictEqual(await verifyPassword('', 'x'), false);
});

test('secret box round-trips and is non-deterministic', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const a = sealSecret(secret);
  const b = sealSecret(secret);
  assert.notStrictEqual(a, b, 'same plaintext must produce different ciphertext');
  assert.strictEqual(openSecret(a), secret);
  assert.strictEqual(openSecret(b), secret);
});

test('secret box rejects tampered ciphertext (GCM tag)', () => {
  const sealed = sealSecret('secret-value');
  const parts = sealed.split('.');
  const tampered = [parts[0], parts[1], Buffer.from('deadbeef', 'hex').toString('base64')].join('.');
  assert.throws(() => openSecret(tampered));
});

test('hmac is stable for the same pepper and input', () => {
  assert.strictEqual(hmac('token-value'), hmac('token-value'));
  assert.notStrictEqual(hmac('token-value'), hmac('other-value'));
  assert.match(hmac('token-value'), /^[0-9a-f]{64}$/);
});

test('randomToken is url-safe and unique', () => {
  const tokens = new Set();
  for (let i = 0; i < 200; i += 1) tokens.add(randomToken(32));
  assert.strictEqual(tokens.size, 200);
  for (const t of tokens) assert.match(t, /^[A-Za-z0-9_-]+$/);
});

test('shutdown closes the database', async () => {
  await harness.shutdown();
});
