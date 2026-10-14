'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

// Env validation runs in a child process so it cannot poison this process's
// environment or the module cache.

const SCRIPT = `
  process.env.NODE_ENV='test';
  const { loadEnv } = require(${JSON.stringify(require.resolve('../../src/config/env'))});
  const os = require('node:os');
  const path = require('node:path');
  const base = {
    MONGODB_URI: 'mongodb://127.0.0.1:27017/x',
    CLIENT_ORIGIN: 'http://localhost:5173',
    SESSION_PEPPER: 'a'.repeat(32),
    MFA_ENCRYPTION_KEY: Buffer.alloc(32,1).toString('base64'),
    DOCUMENT_STORAGE_ROOT: path.join(os.tmpdir(), 'velora-env-test-docs'),
    DOCUMENT_ENCRYPTION_KEY: Buffer.alloc(32,2).toString('base64'),
  };
  const mode = process.argv[1];
  const env = { ...base };
  if (mode === 'missing-uri') delete env.MONGODB_URI;
  if (mode === 'missing-doc-root') delete env.DOCUMENT_STORAGE_ROOT;
  if (mode === 'bad-doc-key') env.DOCUMENT_ENCRYPTION_KEY = 'not-32-bytes';
  if (mode === 'in-repo-root') env.DOCUMENT_STORAGE_ROOT = path.resolve(process.cwd(), 'inside-repo');
  if (mode === 'empty-port') env.PORT = '';
  if (mode === 'zero-port') env.PORT = '0';
  if (mode === 'bad-key') env.MFA_ENCRYPTION_KEY = 'not-base64-32-bytes';
  if (mode === 'short-pepper') env.SESSION_PEPPER = 'short';
  if (mode === 'http-prod') { env.NODE_ENV = 'production'; env.CLIENT_ORIGIN = 'http://insecure.example'; }
  if (mode === 'ok') env.PORT = '5000';
  if (mode === 'bad-reminder-provider') env.REMINDER_PROVIDER = 'Email Gateway';
  if (mode === 'zero-reminder-attempts') env.REMINDER_MAX_ATTEMPTS = '0';
  if (mode === 'too-many-reminder-attempts') env.REMINDER_MAX_ATTEMPTS = '9';
  if (mode === 'bad-timezone') env.SCHEDULE_FALLBACK_TIMEZONE = 'Mars/Olympus';
  try {
    const parsed = loadEnv(env);
    console.log('OK ' + JSON.stringify({
      port: parsed.PORT,
      trust: parsed.TRUST_PROXY,
      reminderProvider: parsed.REMINDER_PROVIDER,
      reminderAttempts: parsed.REMINDER_MAX_ATTEMPTS,
    }));
  } catch (e) {
    console.log('FAIL ' + e.message);
  }
`;

function run(mode) {
  const out = execFileSync(process.execPath, ['-e', SCRIPT, mode], {
    encoding: 'utf8',
  }).trim();
  return out;
}

test('valid environment loads with defaults', () => {
  const out = run('ok');
  assert.match(out, /^OK /, out);
  assert.match(out, /"port":5000/);
});

test('missing MONGODB_URI fails closed', () => {
  const out = run('missing-uri');
  assert.match(out, /^FAIL /, out);
  assert.match(out, /MONGODB_URI/);
});

test('empty PORT is treated as absent and falls back to default', () => {
  const out = run('empty-port');
  assert.match(out, /^OK /, out);
  assert.match(out, /"port":4000/);
});

test('PORT=0 is rejected', () => {
  const out = run('zero-port');
  assert.match(out, /^FAIL /, out);
  assert.match(out, /PORT/);
});

test('malformed MFA key is rejected', () => {
  const out = run('bad-key');
  assert.match(out, /^FAIL /, out);
  assert.match(out, /MFA_ENCRYPTION_KEY/);
});

test('short SESSION_PEPPER is rejected', () => {
  const out = run('short-pepper');
  assert.match(out, /^FAIL /, out);
  assert.match(out, /SESSION_PEPPER/);
});

test('production requires https CLIENT_ORIGIN', () => {
  const out = run('http-prod');
  assert.match(out, /^FAIL /, out);
  assert.match(out, /CLIENT_ORIGIN/);
});

test('failure messages never echo secret values', () => {
  const out = run('bad-key');
  assert.ok(!out.includes('not-base64'), 'must not echo the bad key value');
});

test('a missing document storage root fails closed', () => {
  const out = run('missing-doc-root');
  assert.match(out, /^FAIL /, out);
  assert.match(out, /DOCUMENT_STORAGE_ROOT/);
});

test('a malformed document key is rejected', () => {
  const out = run('bad-doc-key');
  assert.match(out, /^FAIL /, out);
  assert.match(out, /DOCUMENT_ENCRYPTION_KEY/);
});

test('a document storage root inside the repository is rejected', () => {
  const out = run('in-repo-root');
  assert.match(out, /^FAIL /, out);
  assert.match(out, /DOCUMENT_STORAGE_ROOT/);
});

test('the in-app reminder provider is the default and needs no key', () => {
  const out = run('ok');
  assert.match(out, /"reminderProvider":"in_app"/);
  assert.match(out, /"reminderAttempts":3/);
});

test('a malformed REMINDER_PROVIDER is refused rather than coerced', () => {
  const out = run('bad-reminder-provider');
  assert.match(out, /^FAIL /, out);
  assert.match(out, /REMINDER_PROVIDER/);
  assert.ok(!out.includes('Email Gateway'), 'must not echo the rejected value');
});

test('REMINDER_MAX_ATTEMPTS is bounded and refuses 0 or an unbounded chain', () => {
  assert.match(run('zero-reminder-attempts'), /^FAIL /);
  assert.match(run('too-many-reminder-attempts'), /^FAIL /);
});

test('an invalid scheduling timezone fails closed', () => {
  const out = run('bad-timezone');
  assert.match(out, /^FAIL /, out);
  assert.match(out, /SCHEDULE_FALLBACK_TIMEZONE/);
});
