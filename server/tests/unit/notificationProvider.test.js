'use strict';

// The provider registry is the gate that keeps an undisclosed external service
// from ever sending a reminder. These tests run the real environment loader, so a
// deployment that names an unauthorized provider fails closed.
process.env.NODE_ENV = 'test';
process.env.PORT = '4199';
process.env.MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://127.0.0.1:27019/velora_test?replicaSet=rs0';
process.env.CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
process.env.SESSION_PEPPER = 'test_pepper_0123456789abcdef';
process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
process.env.DOCUMENT_STORAGE_ROOT =
  process.env.DOCUMENT_STORAGE_ROOT || require('node:path').join(require('node:os').tmpdir(), 'velora-documents-test');
process.env.DOCUMENT_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadEnv } = require('../../src/config/env');
loadEnv();

const registry = require('../../src/providers/notificationProvider');

test('in-app is the shipped provider and needs no key', () => {
  const provider = registry.resolveProvider('in_app');
  assert.equal(provider.name, 'in_app');
  assert.equal(provider.external, false);
  assert.equal(provider.disclosure.keyName, 'none');
  assert.equal(provider.disclosure.envVar, 'none');
});

test('an undisclosed external provider is refused, and never substituted', () => {
  for (const name of ['email', 'sms', 'whatsapp', 'push']) {
    assert.throws(() => registry.resolveProvider(name), (err) => {
      assert.match(err.message, /not authorized/i);
      // The refusal names exactly what has to be disclosed first.
      assert.match(err.message, /keyName/);
      assert.match(err.message, /retention/);
      assert.match(err.message, /cost/);
      return true;
    });
  }
});

test('an unknown provider name fails closed instead of sending nothing quietly', () => {
  assert.throws(() => registry.resolveProvider('carrier-pigeon'), /Unknown reminder provider/);
});

test('the shipped status discloses what is configured and what is pending', () => {
  const status = registry.providerStatus();
  assert.equal(status.configured, 'in_app');
  assert.equal(status.active, 'in_app');
  assert.deepEqual(status.available, ['in_app', 'fake']);
  assert.deepEqual(status.pendingDisclosure, ['email', 'sms', 'whatsapp', 'push']);
  // Every disclosure field is declared, so a future provider cannot be enabled
  // with a blank one.
  assert.deepEqual(status.disclosureFields, [
    'provider',
    'purpose',
    'keyName',
    'envVar',
    'runsOn',
    'dataSent',
    'retention',
    'region',
    'cost',
  ]);
  assert.deepEqual(registry.disclosureProblems(status.disclosure), []);
  assert.match(
    registry.disclosureProblems({ provider: 'x' })[0],
    /missing: purpose/
  );
  assert.match(registry.disclosureProblems(null)[0], /disclosure is required/i);
});

test('the in-app provider records delivery without claiming acknowledgement', async () => {
  const provider = registry.resolveProvider('in_app');
  const result = await provider.deliver({ notification: { _id: 'n1', title: 'Take your medicine' }, attempt: 1 });
  assert.equal(result.outcome, 'delivered');
  assert.equal(result.detail.attempt, 1);
  assert.ok(!/acknowledg/i.test(JSON.stringify(result)), 'delivery is not acknowledgement');
});
