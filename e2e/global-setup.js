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
const os = require('node:os');
const path = require('node:path');
const otpauth = require('otpauth');

const ROOT = path.resolve(__dirname, '..');
const AUTH_DIR = path.join(__dirname, '.auth');
const PASSWORD = 'SyntheticDevPass!24';

// One enrolled session per role that has screens to measure. The admin session
// additionally reaches the admin-only clinic/staff screen, and the Part 4
// sessions drive the document screens (assigned coordinator) and the read-only
// patient view. Each session is saved here so a spec never has to re-enroll an
// account through the UI (which is a one-time journey in auth.spec).
const SESSIONS = [
  { email: 'reviewer@synthetic.invalid', file: 'viewport-reviewer.json' },
  { email: 'admin@synthetic.invalid', file: 'viewport-admin.json' },
  { email: 'docsview@synthetic.invalid', file: 'docs-coordinator.json' },
  { email: 'patient.docs@synthetic.invalid', file: 'docs-patient.json' },
  { email: 'caregiver.docs@synthetic.invalid', file: 'docs-caregiver.json' },
];

// Minimal .env reader so the seed uses the SAME database as the running API
// without duplicating values. Only names/URLs are read; secrets stay in the
// file and are never printed. An exported value always wins.
function readDotEnv() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const out = {};
    for (const line of raw.split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (match && out[match[1]] === undefined) out[match[1]] = match[2];
    }
    return out;
  } catch {
    return {};
  }
}

function seedEnv() {
  const fileEnv = readDotEnv();
  // Treat an empty or '0' exported value as absent (a host shell may export
  // PORT=0), so the workspace .env wins in that case.
  const pick = (key, fallback) => {
    const exported = process.env[key];
    if (exported && exported !== '0') return exported;
    return fileEnv[key] && fileEnv[key] !== '0' ? fileEnv[key] : fallback;
  };
  return {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV && process.env.NODE_ENV !== 'test' ? process.env.NODE_ENV : 'development',
    // The host shell sometimes exports PORT=0; the seed must not inherit it.
    PORT: process.env.PORT && process.env.PORT !== '0' ? process.env.PORT : pick('PORT', '4000'),
    // Part 2+ writes inside transactions, so the application database must be a
    // replica set. The local `mongo:test-rs` instance serves this URI too.
    MONGODB_URI: pick('MONGODB_URI', 'mongodb://127.0.0.1:27019/velora?replicaSet=rs0'),
    // Part 4: the seed now validates the document environment too, so pass the
    // same root/key the API uses (a fallback OUTSIDE the repo is used if the
    // workspace .env has none).
    DOCUMENT_STORAGE_ROOT: pick('DOCUMENT_STORAGE_ROOT', path.join(os.tmpdir(), 'velora-documents-e2e')),
    DOCUMENT_ENCRYPTION_KEY: pick('DOCUMENT_ENCRYPTION_KEY', Buffer.alloc(32, 5).toString('base64')),
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

  // Derive the API base from the same PORT the server was started with (CI
  // uses 4100), and prefer 127.0.0.1 to avoid a localhost -> ::1 miss.
  const fileEnv = readDotEnv();
  const apiPort =
    process.env.PORT && process.env.PORT !== '0'
      ? process.env.PORT
      : fileEnv.PORT && fileEnv.PORT !== '0'
        ? fileEnv.PORT
        : '4000';
  const apiBase = process.env.E2E_API_URL || `http://127.0.0.1:${apiPort}`;
  await waitForApi(apiBase);
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  for (const s of SESSIONS) {
    const state = await enrolledStorageState(apiBase, s.email);
    fs.writeFileSync(path.join(AUTH_DIR, s.file), JSON.stringify(state, null, 2));
    process.stdout.write(`[e2e] enrolled session written for ${s.email}\n`);
  }
};
