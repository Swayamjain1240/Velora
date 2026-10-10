'use strict';

// Runs once before the browser journeys. It:
//   1. re-seeds the synthetic clinic so the documented forced-enrollment path is
//      reproducible on every run (accounts have MFA disabled, buckets cleared);
//   2. enrols one synthetic account through the real API and writes its cookie
//      session to e2e/.auth/viewport.json.
// The saved session lets the viewport spec avoid repeating the enrollment UI,
// and means a Playwright worker restart cannot re-run a one-time enrollment.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const otpauth = require('otpauth');

const ROOT = path.resolve(__dirname, '..');
const AUTH_DIR = path.join(__dirname, '.auth');
const PASSWORD = 'SyntheticDevPass!24';

// One enrolled session per role that has screens to measure. The admin session
// additionally reaches the admin-only clinic/staff screen.
const SESSIONS = [
  { email: 'reviewer@synthetic.invalid', file: 'viewport-reviewer.json' },
  { email: 'admin@synthetic.invalid', file: 'viewport-admin.json' },
];

function seedEnv() {
  return {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV && process.env.NODE_ENV !== 'test' ? process.env.NODE_ENV : 'development',
    // The host shell sometimes exports PORT=0; the seed must not inherit it.
    PORT: process.env.PORT && process.env.PORT !== '0' ? process.env.PORT : '4000',
    MONGODB_URI: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/velora',
    CLIENT_ORIGIN: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
    SESSION_PEPPER: process.env.SESSION_PEPPER || 'localdev_session_pepper_0123456789abcdef',
    MFA_ENCRYPTION_KEY: process.env.MFA_ENCRYPTION_KEY || Buffer.alloc(32, 7).toString('base64'),
    SESSION_TTL_HOURS: process.env.SESSION_TTL_HOURS || '12',
  };
}

function parseSetCookie(raw) {
  const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
  const eq = pair.indexOf('=');
  const cookie = { name: pair.slice(0, eq), value: pair.slice(eq + 1), domain: 'localhost', path: '/' };
  for (const attr of attrs) {
    const [k, v] = attr.split('=');
    const key = k.toLowerCase();
    if (key === 'path') cookie.path = v || '/';
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'samesite') cookie.sameSite = v;
  }
  return cookie;
}

function totpCode(secretBase32, account) {
  const gen = new otpauth.TOTP({
    issuer: 'Velora',
    label: account,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: otpauth.Secret.fromBase32(secretBase32),
  });
  return gen.generate();
}

async function enrolledStorageState(apiBase, email) {
  const jar = new Map();
  const capture = (res) => {
    for (const raw of res.headers.getSetCookie()) {
      const cookie = parseSetCookie(raw);
      jar.set(cookie.name, cookie);
    }
  };
  const cookieHeader = () => [...jar.values()].map((c) => `${c.name}=${c.value}`).join('; ');

  const login = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  capture(login);
  const body = await login.json();
  if (body.next !== 'mfa_enroll') {
    throw new Error(`global setup expected mfa_enroll, got ${JSON.stringify(body)}`);
  }
  const csrf = jar.get('velora_csrf');
  if (!csrf) throw new Error('global setup: no velora_csrf cookie after login');

  const setup = await fetch(`${apiBase}/api/auth/mfa/enroll/setup`, {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrf.value, Cookie: cookieHeader() },
  });
  capture(setup);
  const { secretBase32 } = await setup.json();

  const verify = await fetch(`${apiBase}/api/auth/mfa/enroll/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.value, Cookie: cookieHeader() },
    body: JSON.stringify({ code: totpCode(secretBase32, email) }),
  });
  capture(verify);
  if (!verify.ok) throw new Error(`global setup enroll verify failed: ${verify.status}`);

  return { cookies: [...jar.values()], origins: [] };
}

async function waitForApi(apiBase, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`${apiBase}/api/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`API not reachable at ${apiBase}/api/health`);
}

module.exports = async () => {
  execFileSync(process.execPath, ['scripts/seed.js'], {
    cwd: path.join(ROOT, 'server'),
    env: seedEnv(),
    stdio: 'inherit',
  });

  // 127.0.0.1 avoids a localhost -> ::1 resolution miss on some hosts.
  const apiBase = process.env.E2E_API_URL || 'http://127.0.0.1:4000';
  await waitForApi(apiBase);
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  for (const s of SESSIONS) {
    const state = await enrolledStorageState(apiBase, s.email);
    fs.writeFileSync(path.join(AUTH_DIR, s.file), JSON.stringify(state, null, 2));
    process.stdout.write(`[e2e] enrolled session written for ${s.email}\n`);
  }
};
