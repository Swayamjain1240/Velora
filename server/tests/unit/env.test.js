'use strict';

// Part 10: the production configuration gate.
//
// Every rule here exists to stop a deployment that LOOKS fine but is not: debug
// diagnostics on, a reused encryption key, a development-strength session pepper
// or an unencrypted database connection. The assertions check that each one
// fails CLOSED with a message that names the field and never echoes a value.

const { test } = require('node:test');
const assert = require('node:assert/strict');
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

  // ---- Part 10 production cases -------------------------------------------------
  const prod = () => {
    env.NODE_ENV = 'production';
    env.CLIENT_ORIGIN = 'https://app.example.test';
    env.MONGODB_URI = 'mongodb://db.internal:27017/velora?replicaSet=rs0&tls=true';
  };
  if (mode === 'prod-ok') prod();
  if (mode === 'prod-debug-log') { prod(); env.LOG_LEVEL = 'debug'; }
  if (mode === 'prod-short-pepper') { prod(); env.SESSION_PEPPER = 'too-short-for-production'; }
  if (mode === 'prod-reused-keys') { prod(); env.DOCUMENT_ENCRYPTION_KEY = env.MFA_ENCRYPTION_KEY; }
  if (mode === 'prod-reused-export-key') {
    prod();
    env.PRIVACY_EXPORT_ENCRYPTION_KEY = env.MFA_ENCRYPTION_KEY;
  }
  if (mode === 'prod-plaintext-mongo') {
    prod();
    env.MONGODB_URI = 'mongodb://db.internal:27017/velora?replicaSet=rs0';
  }
  if (mode === 'prod-http-origin') { prod(); env.CLIENT_ORIGIN = 'http://app.example.test'; }
  if (mode === 'origin-with-path') { env.CLIENT_ORIGIN = 'http://localhost:5173/app'; }
  if (mode === 'origin-with-slash') { env.CLIENT_ORIGIN = 'http://localhost:5173/'; }
  if (mode === 'min-pool-too-big') { env.MONGO_MIN_POOL_SIZE = '20'; env.MONGO_MAX_POOL_SIZE = '5'; }
  if (mode === 'trust-on') { env.TRUST_PROXY = 'true'; env.PROXY_HOPS = '2'; }
  if (mode === 'bad-proxy-hops') { env.TRUST_PROXY = 'true'; env.PROXY_HOPS = '9'; }
  try {
    const parsed = loadEnv(env);
    console.log('OK ' + JSON.stringify({
      port: parsed.PORT,
      trust: parsed.TRUST_PROXY,
      proxyHops: parsed.PROXY_HOPS,
      reminderProvider: parsed.REMINDER_PROVIDER,
      reminderAttempts: parsed.REMINDER_MAX_ATTEMPTS,
      logLevel: parsed.LOG_LEVEL,
      jsonBodyLimitKb: parsed.JSON_BODY_LIMIT_KB,
      requestTimeoutMs: parsed.REQUEST_TIMEOUT_MS,
      mongoPoolMax: parsed.MONGO_MAX_POOL_SIZE,
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

// ---- Part 10: production configuration gate --------------------------------------

test('a complete production configuration loads', () => {
  const out = run('prod-ok');
  assert.match(out, /^OK /, out);
  assert.match(out, /"logLevel":"info"/, out);
});

test('production refuses debug logging rather than warning about it', () => {
  const out = run('prod-debug-log');
  assert.match(out, /^FAIL /, out);
  assert.match(out, /LOG_LEVEL/);
});

test('production requires a session pepper of at least 32 characters', () => {
  const out = run('prod-short-pepper');
  assert.match(out, /^FAIL /, out);
  assert.match(out, /SESSION_PEPPER/);
});

test('production refuses a document key reused from the MFA key', () => {
  const out = run('prod-reused-keys');
  assert.match(out, /^FAIL /, out);
  assert.match(out, /DOCUMENT_ENCRYPTION_KEY/);
  assert.ok(!out.includes('base64'), 'must not echo key material');
});

test('production refuses a privacy export key reused from another store', () => {
  const out = run('prod-reused-export-key');
  assert.match(out, /^FAIL /, out);
  assert.match(out, /PRIVACY_EXPORT_ENCRYPTION_KEY/);
});

test('production requires an encrypted database connection', () => {
  const out = run('prod-plaintext-mongo');
  assert.match(out, /^FAIL /, out);
  assert.match(out, /MONGODB_URI/);
  assert.ok(!out.includes('db.internal'), 'must not echo the connection string');
});

test('production refuses a plain-http client origin', () => {
  const out = run('prod-http-origin');
  assert.match(out, /^FAIL /, out);
  assert.match(out, /CLIENT_ORIGIN/);
});

test('CLIENT_ORIGIN must be a bare origin, not a URL with a path or a trailing slash', () => {
  for (const mode of ['origin-with-path', 'origin-with-slash']) {
    const out = run(mode);
    assert.match(out, /^FAIL /, out);
    assert.match(out, /CLIENT_ORIGIN/);
  }
});

test('the connection pool is bounded and a minimum above the maximum is refused', () => {
  assert.match(run('ok'), /"mongoPoolMax":10/);
  const out = run('min-pool-too-big');
  assert.match(out, /^FAIL /, out);
  assert.match(out, /MONGO_MIN_POOL_SIZE/);
});

test('proxy trust carries an explicit hop count and is bounded', () => {
  const out = run('trust-on');
  assert.match(out, /"trust":true/, out);
  assert.match(out, /"proxyHops":2/, out);
  const bad = run('bad-proxy-hops');
  assert.match(bad, /^FAIL /, bad);
  assert.match(bad, /PROXY_HOPS/);
});
