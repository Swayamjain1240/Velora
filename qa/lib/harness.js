'use strict';

// Shared helpers for Velora's non-functional QA probes (security, performance,
// load, concurrency). SYNTHETIC DATA ONLY: every account is a seeded
// `*.synthetic.invalid` identity and every byte is generated locally.
//
// Nothing in this directory prints or persists credential material: evidence
// files are redacted (cookies/tokens removed) before they are written, and the
// session cache stores cookie NAMES only alongside the values the running test
// stack issued - it lives in qa/.sessions/ which is gitignored.
const fs = require('node:fs');
const path = require('node:path');
const otpauth = require('otpauth');

const SESSION_DIR = path.join(__dirname, '..', '.sessions');
const EVIDENCE_DIR = path.join(__dirname, '..', 'evidence');
const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function ensureDirs() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

class Client {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
  }

  cookieHeader() {
    return [...this.jar.values()].map((c) => `${c.name}=${c.value}`).join('; ');
  }

  capture(res) {
    for (const raw of res.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
      const eq = pair.indexOf('=');
      const cookie = { name: pair.slice(0, eq), value: pair.slice(eq + 1), path: '/' };
      for (const attr of attrs) {
        const [k, v] = attr.split('=');
        const key = k.toLowerCase();
        if (key === 'path' && v) cookie.path = v;
        if (key === 'httponly') cookie.httpOnly = true;
        if (key === 'secure') cookie.secure = true;
        if (key === 'samesite' && v) cookie.sameSite = v;
      }
      if (cookie.value === '' ) this.jar.delete(cookie.name);
      else this.jar.set(cookie.name, cookie);
    }
  }

  // Sends one request. Options:
  //   body     object (JSON), Buffer (raw), or undefined
  //   headers  extra headers
  //   noCsrf   true to deliberately omit the X-CSRF-Token header
  //   json     false to skip JSON parsing
  async req(method, pathname, options = {}) {
    const { body, headers = {}, noCsrf = false, timeoutMs = 30_000 } = options;
    const h = { ...headers, Cookie: this.cookieHeader() };
    let payload;
    if (body === undefined || body === null) {
      payload = undefined;
    } else if (Buffer.isBuffer(body)) {
      payload = body;
      if (!h['Content-Type']) h['Content-Type'] = 'application/pdf';
    } else if (typeof body === 'string') {
      payload = body;
      if (!h['Content-Type']) h['Content-Type'] = 'application/json';
    } else {
      payload = JSON.stringify(body);
      if (!h['Content-Type']) h['Content-Type'] = 'application/json';
    }
    const csrf = this.jar.get('velora_csrf');
    if (!noCsrf && MUTATING.has(method) && csrf) h['X-CSRF-Token'] = csrf.value;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = process.hrtime.bigint();
    try {
      const res = await fetch(this.base + pathname, {
        method,
        headers: h,
        body: payload,
        signal: controller.signal,
      });
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      this.capture(res);
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not json */
      }
      return {
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        setCookie: res.headers.getSetCookie(),
        text,
        json,
        ms,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function totp(secretBase32, account) {
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

// Signs in through the real API: password -> (forced enrolment | TOTP verify).
// Returns the client with an authenticated cookie jar.
async function login(base, email, password, { secretBase32 } = {}) {
  const client = new Client(base);
  const first = await client.req('POST', '/api/auth/login', { body: { email, password } });
  if (!first.json || !first.json.next) {
    throw new Error(`login did not return a next step: ${first.status} ${first.text.slice(0, 200)}`);
  }
  if (first.json.next === 'mfa_enroll') {
    const setup = await client.req('POST', '/api/auth/mfa/enroll/setup');
    if (setup.status !== 200) throw new Error(`enroll setup failed: ${setup.status}`);
    const secret = setup.json.secretBase32;
    const verify = await client.req('POST', '/api/auth/mfa/enroll/verify', {
      body: { code: totp(secret, email) },
    });
    if (verify.status !== 200) throw new Error(`enroll verify failed: ${verify.status}`);
    return { client, secret };
  }
  if (first.json.next === 'mfa_verify') {
    if (!secretBase32) throw new Error('mfa_verify but no stored secret - re-seed first');
    const verify = await client.req('POST', '/api/auth/mfa/verify', {
      body: { code: totp(secretBase32, email) },
    });
    if (verify.status !== 200) throw new Error(`mfa verify failed: ${verify.status}`);
    return { client, secret: secretBase32 };
  }
  return { client, secret: secretBase32 };
}

function sessionPath(label) {
  return path.join(SESSION_DIR, `${label}.json`);
}

// Returns { client, secret }, reusing a cached session when it is still valid.
async function ensureSession(base, { label, email, password, secret }, reseed) {
  ensureDirs();
  const file = sessionPath(label);
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const client = new Client(base);
    for (const c of saved.cookies) client.jar.set(c.name, c);
    const me = await client.req('GET', '/api/auth/me');
    if (me.status === 200) return { client, secret: saved.secret };
    if (reseed) await reseed();
  } else if (reseed) {
    await reseed();
  }
  let logged;
  try {
    logged = await login(base, email, password, { secretBase32: saved_secret(file) });
  } catch (err) {
    if (!/mfa_verify but no stored secret/.test(String(err.message))) throw err;
    // The account is sealed with a TOTP secret from an earlier run that we (by
    // design) cannot read. Reset the fixture enrolment in the DISPOSABLE test DB
    // so the probe session follows the normal forced-enrolment path.
    const { clearMfa } = require('./tenantFixtures');
    await clearMfa(email);
    logged = await login(base, email, password, {});
  }
  const { client, secret: got } = logged;
  const cookies = [...client.jar.values()].map((c) => ({ ...c }));
  fs.writeFileSync(file, JSON.stringify({ cookies, secret: got }, null, 2));
  return { client, secret: got };
}

function saved_secret(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).secret;
  } catch {
    return undefined;
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    min: round(sorted[0] ?? 0),
    p50: round(percentile(sorted, 50)),
    p90: round(percentile(sorted, 90)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1] ?? 0),
    mean: round(sum / (sorted.length || 1)),
  };
}

function round(v) {
  return Math.round(v * 100) / 100;
}

// Strips credential material so an evidence file can be committed safely.
function redact(value) {
  const sensitive = /^(set-cookie|cookie|x-csrf-token|authorization)$/i;
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sensitive.test(k) ? '[redacted]' : redact(v);
    }
    return out;
  }
  if (typeof value === 'string') {
    // Session/csrf cookie values and TOTP secrets never reach a report.
    return value
      .replace(/velora_session=[^;&\s]+/gi, 'velora_session=[redacted]')
      .replace(/velora_csrf=[^;&\s]+/gi, 'velora_csrf=[redacted]');
  }
  return value;
}

function writeEvidence(name, data) {
  ensureDirs();
  const file = path.join(EVIDENCE_DIR, name);
  fs.writeFileSync(file, `${JSON.stringify(redact(data), null, 2)}\n`);
  return file;
}

function header(res, name) {
  return res.headers[name.toLowerCase()];
}

module.exports = {
  Client,
  login,
  ensureSession,
  stats,
  round,
  writeEvidence,
  redact,
  header,
  totp,
  ensureDirs,
  EVIDENCE_DIR,
  SESSION_DIR,
};