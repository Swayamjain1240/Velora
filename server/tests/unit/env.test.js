'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

// Env validation runs in a child process so it cannot poison this process's
// environment or the module cache.

const SCRIPT = `
  process.env.NODE_ENV='test';
  const { loadEnv } = require(${JSON.stringify(require.resolve('../../src/config/env'))});
  const base = {
    MONGODB_URI: 'mongodb://127.0.0.1:27017/x',
    CLIENT_ORIGIN: 'http://localhost:5173',
    SESSION_PEPPER: 'a'.repeat(32),
    MFA_ENCRYPTION_KEY: Buffer.alloc(32,1).toString('base64'),
  };
  const mode = process.argv[1];
  const env = { ...base };
  if (mode === 'missing-uri') delete env.MONGODB_URI;
  if (mode === 'empty-port') env.PORT = '';
  if (mode === 'zero-port') env.PORT = '0';
  if (mode === 'bad-key') env.MFA_ENCRYPTION_KEY = 'not-base64-32-bytes';
  if (mode === 'short-pepper') env.SESSION_PEPPER = 'short';
  if (mode === 'http-prod') { env.NODE_ENV = 'production'; env.CLIENT_ORIGIN = 'http://insecure.example'; }
  if (mode === 'ok') env.PORT = '5000';
  try {
    const parsed = loadEnv(env);
    console.log('OK ' + JSON.stringify({ port: parsed.PORT, trust: parsed.TRUST_PROXY }));
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
