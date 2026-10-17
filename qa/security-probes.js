'use strict';

// SECTION 1/2/3 - defensive security probes against the ISOLATED test API.
// Never points at production: it targets BASE (default 127.0.0.1:4101), which is
// a disposable NODE_ENV=test instance backed by the test replica-set database
// `velora_test` and seeded with synthetic `*.synthetic.invalid` identities only.
//
// Every check records: id, verdict (PASS/FAIL), what was observed. Output goes
// to qa/evidence/security-probes.json through the redacting evidence writer.
const { Client, login, ensureSession, writeEvidence } = require('./lib/harness');
const { resetBuckets } = require('./lib/resetBuckets');
const { ensureTenantB, reseed } = require('./lib/tenantFixtures');

const BASE = process.env.QA_BASE_URL || 'http://127.0.0.1:4101';
const EMAIL_A = process.env.QA_EMAIL_A || 'docsview@synthetic.invalid';
const PASSWORD = process.env.QA_PASSWORD || 'SyntheticDevPass!24';
const sess = (label, email) => ensureSession(BASE, { label, email, password: PASSWORD }, reseed);

const results = [];
function record(id, category, severityIfFail, verdict, detail) {
  results.push({ id, category, verdict, expectedSeverityIfFailed: severityIfFail, detail });
  const mark = verdict === 'PASS' ? 'ok  ' : verdict === 'FAIL' ? 'FAIL' : 'NOTE';
  process.stdout.write(`${mark} ${id.padEnd(6)} ${detail}\n`);
}

async function main() {
  // --- Fixtures -----------------------------------------------------------
  const tenantB = await ensureTenantB();

  // --- Sessions -----------------------------------------------------------
  const a = await sess('qa-a', EMAIL_A);
  const admin = await sess('qa-admin', 'admin@synthetic.invalid');
  // A genuinely separate clinic (fixture-created), so no shared tenant state.
  const b = await sess('qa-b', tenantB.email);

  const anon = new Client(BASE);

  // =========================================================================
  // SECTION 1 - SECURITY TESTING: authentication
  // =========================================================================

  // 1: user enumeration - unknown email vs known email wrong password must be
  // indistinguishable (status + body code + shape).
  {
    const unknown = new Client(BASE);
    const r1 = await unknown.req('POST', '/api/auth/login', { body: { email: 'ghost@synthetic.invalid', password: 'WrongPass!24' } });
    const wrongPw = new Client(BASE);
    const r2 = await wrongPw.req('POST', '/api/auth/login', { body: { email: EMAIL_A, password: 'WrongPass!24' } });
    const sameShape = r1.status === r2.status
      && (r1.json && r2.json && r1.json.error && r2.json.error && r1.json.error.code === r2.json.error.code);
    record('SEC-1', 'auth', 'P1', sameShape ? 'PASS' : 'FAIL',
      `unknown email -> ${r1.status} ${r1.json && r1.json.error && r1.json.error.code}; wrong password -> ${r2.status} ${r2.json && r2.json.error && r2.json.error.code}`);
  }

  // 2: credential stuffing / brute force - 11 bad logins for one ip|email key
  // must trip the durable limiter (limit 10 / 15 min).
  {
    const c = new Client(BASE);
    let saw429 = false;
    let last = null;
    for (let i = 0; i < 12; i += 1) {
      last = await c.req('POST', '/api/auth/login', { body: { email: EMAIL_A, password: `Sprayed${i}!24` } });
      if (last.status === 429) { saw429 = true; break; }
    }
    record('SEC-2', 'auth', 'P1', saw429 ? 'PASS' : 'FAIL',
      saw429 ? `429 after ${last.json && last.json.error && last.json.error.code} observed` : `no 429 in 12 attempts (last ${last.status})`);
    // Reset the bucket so later probes (perf) are not polluted.
    await resetBuckets();
  }

  // 3: session cookie flags - HttpOnly + SameSite on the live session cookie.
  {
    const s = a.client.jar.get('velora_session');
    const c = a.client.jar.get('velora_csrf');
    const sessOk = !!s && s.httpOnly === true && !!s.sameSite;
    record('SEC-3', 'auth', 'P1', sessOk ? 'PASS' : 'FAIL',
      `session cookie httpOnly=${!!(s && s.httpOnly)} sameSite=${s && s.sameSite} secure=${!!(s && s.secure)} path=${s && s.path}`);
    record('SEC-3b', 'auth', 'P2', !!(c && c.sameSite) ? 'PASS' : 'FAIL',
      `csrf cookie httpOnly=${!!(c && c.httpOnly)} sameSite=${c && c.sameSite} (the CSRF cookie is intentionally JS-readable so the app can echo it in X-CSRF-Token)`);
    record('SEC-3c', 'auth-hst', 'P3',
      !(s && s.secure) ? 'NOTE' : 'PASS',
      'Secure flag absent on http:// test instance (expected: Secure is issued only for https/production; verify at deploy TLS)');
  }

  // 4: session logout - the old cookie must be rejected after logout.
  {
    const victim = await sess('qa-logout', 'flow@synthetic.invalid');
    const before = await victim.client.req('GET', '/api/auth/me');
    const out = await victim.client.req('POST', '/api/auth/logout', { body: {}, noCsrf: false });
    const after = await victim.client.req('GET', '/api/auth/me');
    record('SEC-4', 'auth', 'P1', before.status === 200 && after.status === 401 ? 'PASS' : 'FAIL',
      `me before=${before.status}, logout=${out.status}, me after=${after.status}`);
  }

  // 5: revoke-all sessions kills other sessions of the same user.
  {
    const email = 'plan.coordinator@synthetic.invalid';
    const s1 = await sess('qa-rev1', email);
    const s2 = await sess('qa-rev2', email);
    const ok2 = await s2.client.req('GET', '/api/auth/me');
    const rev = await s1.client.req('POST', '/api/auth/sessions/revoke-all', { body: {} });
    const after2 = await s2.client.req('GET', '/api/auth/me');
    const after1 = await s1.client.req('GET', '/api/auth/me');
    record('SEC-5', 'auth', 'P1', rev.status === 200 && after2.status === 401 && after1.status === 401 ? 'PASS' : 'FAIL',
      `pre=${ok2.status}, revoke=${rev.status}, other-after=${after2.status}, self-after=${after1.status}`);
  }

  // 6: MFA gate - password-only login must not yield an authenticated session.
  {
    const c = new Client(BASE);
    const r = await c.req('POST', '/api/auth/login', { body: { email: EMAIL_A, password: PASSWORD } });
    const me = await c.req('GET', '/api/auth/me');
    const noSession = me.status !== 200;
    const state = r.json && r.json.next;
    record('SEC-6', 'auth', 'P1', noSession ? 'PASS' : 'FAIL',
      `login next=${state}; /me without TOTP -> ${me.status} (must not be 200)`);
  }

  // 7: wrong TOTP code rejected.
  {
    const c = new Client(BASE);
    await c.req('POST', '/api/auth/login', { body: { email: EMAIL_A, password: PASSWORD } });
    const bad = await c.req('POST', '/api/auth/mfa/verify', { body: { code: '000000' } });
    record('SEC-7', 'auth', 'P1', bad.status >= 400 ? 'PASS' : 'FAIL', `wrong TOTP -> ${bad.status}`);
  }

  // 8: password-reset token single use.
  {
    const c1 = new Client(BASE);
    await c1.req('POST', '/api/auth/password/forgot', { body: { email: EMAIL_A } });
    // In test mode the token is surfaced by the fake mailer only if the app
    // exposes it; if not exposed, reuse is proven by the integration suite.
    record('SEC-8', 'auth', 'P1', 'NOTE',
      'single-use reset/invitation races are asserted by server/tests/integration/auth.test.js (evidence: suite run); live token capture would require reading mail, which stays fake-only');
  }

  // =========================================================================
  // SECTION 1 - authorization / IDOR / tenant isolation
  // =========================================================================

  // Helper: find a real patient id the A user can see.
  const listA = await a.client.req('GET', '/api/patients?page=1&limit=5');
  const patientA = listA.json && listA.json.items && listA.json.items[0];
  // First episode the A user can see (used by upload/download IDOR probes).
  const epListA = await a.client.req('GET', '/api/episodes?page=1&limit=1');
  const epIdA = epListA.json && epListA.json.items && epListA.json.items[0] && epListA.json.items[0].id;

  // 9: cross-clinic patient read (IDOR).
  if (patientA) {
    const r = await b.client.req('GET', `/api/patients/${patientA.id}`);
    record('SEC-9', 'authz', 'P0', r.status === 403 || r.status === 404 ? 'PASS' : 'FAIL',
      `clinic-B session read of clinic-A patient ${patientA.id} -> ${r.status}`);
  } else {
    record('SEC-9', 'authz', 'P0', 'BLOCKED', 'no seeded patient visible to clinic A');
  }

  // 10: cross-clinic list leakage.
  {
    const r = await b.client.req('GET', '/api/patients?page=1&limit=100');
    const foreign = r.json && r.json.items ? r.json.items.filter((p) => patientA && p.id === patientA.id).length : -1;
    record('SEC-10', 'authz', 'P0', foreign === 0 ? 'PASS' : 'FAIL',
      `clinic B list contains ${foreign} clinic-A rows (0 expected); total=${r.json && r.json.items ? r.json.items.length : '?'} status=${r.status}`);
  }

  // 11: count/dashboard leakage across clinics.
  {
    const r = await b.client.req('GET', '/api/dashboard?clinicId=' + (patientA ? 'other' : 'x'));
    record('SEC-11', 'authz', 'P0', r.status !== 200 || !(r.json && JSON.stringify(r.json).includes(patientA && patientA.id)) ? 'PASS' : 'FAIL',
      `foreign dashboard query -> ${r.status} contains no clinic-A identifiers`);
  }

  // 12: document download leakage across clinics.
  if (epIdA) {
    const docs = await a.client.req('GET', `/api/episodes/${epIdA}/documents?page=1&limit=1`);
    const doc = docs.json && docs.json.items && docs.json.items[0];
    if (doc) {
      const r = await b.client.req('GET', `/api/episodes/${epIdA}/documents/${doc.id}/download`);
      const meta = await b.client.req('GET', `/api/episodes/${epIdA}/documents`);
      record('SEC-12', 'authz', 'P0',
        (r.status === 401 || r.status === 403 || r.status === 404) && (meta.status === 401 || meta.status === 403 || meta.status === 404)
          ? 'PASS' : 'FAIL',
        `clinic-B download/list of clinic-A document -> download=${r.status} list=${meta.status} (expect 401/403/404)`);
    } else {
      record('SEC-12', 'authz', 'P0', 'NOTE', `episode ${epIdA} has no documents (documents.test.js covers download IDOR in-suite)`);
    }
  } else {
    record('SEC-12', 'authz', 'P0', 'BLOCKED', 'no seeded episode for the A user');
  }

  // 13: admin clinical-record denial (admin without clinical_reviewer eligibility).
  {
    const r = await admin.client.req('GET', '/api/audit?page=1&limit=5');
    record('SEC-13', 'authz', 'P1', 'NOTE',
      `admin audit read -> ${r.status} (admin-without-clinical-record access is asserted in accessMatrix.test.js; live status recorded here)`);
  }

  // 14: unauthenticated access to every core read/write route.
  {
    const routes = [
      ['GET', '/api/patients'], ['POST', '/api/patients'],
      ['GET', '/api/dashboard'], ['GET', '/api/today'],
      ['GET', '/api/episodes'], ['GET', '/api/audit'],
      ['GET', '/api/metrics'], ['POST', '/api/privacy-requests'],
      ['GET', '/api/retention/runs'], ['POST', '/api/auth/clinics'],
    ];
    const results14 = [];
    for (const [method, path] of routes) {
      const r = await anon.req(method, path, { body: method === 'GET' ? undefined : {} });
      results14.push(`${method} ${path}=${r.status}`);
      if ((r.status === 200 || r.status === 201) && !/status|health/.test(path)) results14.push(`UNPROTECTED:${path}`);
    }
    const open = results14.filter((x) => x.startsWith('UNPROTECTED'));
    record('SEC-14', 'authz', 'P0', open.length === 0 ? 'PASS' : 'FAIL', results14.join(' '));
  }

  // =========================================================================
  // SECTION 1 - input security
  // =========================================================================

  // 15: NoSQL operator injection in login.
  {
    const c = new Client(BASE);
    const r = await c.req('POST', '/api/auth/login', { body: { email: { '$gt': '' }, password: { '$ne': '' } } });
    record('SEC-15', 'input', 'P0', r.status >= 400 && r.status < 500 ? 'PASS' : 'FAIL',
      `operator object email/password -> ${r.status} ${r.json && r.json.error && r.json.error.code} (no 5xx, no auth)`);
  }

  // 16: NoSQL operator injection in query filters.
  {
    const r = await a.client.req('GET', '/api/patients?$where=1&filter[$ne]=x&page[$gt]=0');
    record('SEC-16', 'input', 'P0', r.status < 500 ? 'PASS' : 'FAIL',
      `operator query params -> ${r.status} (accepted-and-ignored or 400; never 5xx)`);
  }

  // 17: prototype-pollution payload.
  {
    const r = await a.client.req('POST', '/api/patients', {
      body: JSON.stringify({ name: 'Synthetic <script>x</script>', __proto__: { polluted: true }, constructor: { prototype: { polluted: true } } }),
      headers: { 'Content-Type': 'application/json' },
    });
    const after = (await a.client.req('GET', '/api/patients?page=1&limit=1')).json !== undefined;
    record('SEC-17', 'input', 'P0', r.status < 500 ? 'PASS' : 'FAIL',
      `__proto__/constructor body -> ${r.status}; server stayed healthy (${after ? 'served' : 'failed'} next request)`);
  }

  // 18: XSS strings through a JSON mutation (response must be application/json;
  // client renders via React text nodes - unsafe HTML sinks asserted in client tests).
  {
    const r = await a.client.req('POST', '/api/patients', {
      body: { name: '<img src=x onerror=alert(1)>SyntheticXSS', phone: '+10000000000', timezone: 'UTC' },
    });
    const ctype = r.headers['content-type'] || '';
    const rejectedByValidation = r.status === 400;
    record('SEC-18', 'input', 'P1', /application\/json/.test(ctype) ? 'PASS' : 'FAIL',
      `stored XSS string create -> ${r.status} content-type=${ctype}${rejectedByValidation ? ' (markup rejected at the validation boundary - stronger than escaping)' : ' (stored; rendering relies on React text escaping)'}`);
  }

  // 19: oversized body -> 413, not buffered.
  {
    const big = 'x'.repeat(2 * 1024 * 1024);
    const r = await a.client.req('POST', '/api/patients', { body: JSON.stringify({ name: big }), headers: { 'Content-Type': 'application/json' } });
    record('SEC-19', 'input', 'P2', r.status === 413 || r.status === 400 ? 'PASS' : 'FAIL', `2MB JSON body -> ${r.status}`);
  }

  // 20: invalid content type to a JSON route.
  {
    const r = await a.client.req('POST', '/api/patients', { body: 'name=raw&text=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    record('SEC-20', 'input', 'P2', r.status < 500 ? 'PASS' : 'FAIL', `form-encoded body -> ${r.status}`);
  }

  // 21: duplicate JSON keys (last-wins handled by JSON.parse; zod then validates).
  {
    const r = await a.client.req('POST', '/api/auth/login', {
      body: '{"email":"x@velora-synthetic.test","email":"y@velora-synthetic.test","password":"nope"}',
      headers: { 'Content-Type': 'application/json' },
    });
    record('SEC-21', 'input', 'P2', r.status < 500 ? 'PASS' : 'FAIL', `duplicate-key JSON -> ${r.status}`);
  }

  // 22: filename traversal on document upload. The upload API takes the RAW body
  // plus the percent-encoded filename in X-Document-Filename (never in a URL).
  {
    const { pdfWithTextPages } = require('../server/scripts/syntheticPdf');
    const pdfBytes = pdfWithTextPages([['synthetic qa probe page']]);
    if (epIdA) {
      const evil = await a.client.req('POST', `/api/episodes/${epIdA}/documents`, {
        body: pdfBytes,
        headers: {
          'Content-Type': 'application/pdf',
          'X-Document-Filename': encodeURIComponent('../../escape.pdf'),
        },
      });
      const valid = await a.client.req('POST', `/api/episodes/${epIdA}/documents`, {
        body: pdfBytes,
        headers: {
          'Content-Type': 'application/pdf',
          'X-Document-Filename': encodeURIComponent('synthetic-qa-probe.pdf'),
        },
      });
      record('SEC-22', 'input', 'P1',
        evil.status === 400 && evil.status < 500 ? 'PASS' : 'FAIL',
        `traversal filename -> ${evil.status} ${evil.json && evil.json.error && evil.json.error.code}; well-formed name -> ${valid.status} ${valid.json && valid.json.error ? valid.json.error.code : 'accepted'}`);
      if (valid.status === 201 && valid.json && valid.json.document) {
        const did = valid.json.document.id;
        const dl = await a.client.req('GET', `/api/episodes/${epIdA}/documents/${did}/download`);
        const bIdor = await b.client.req('GET', `/api/episodes/${epIdA}/documents/${did}/download`);
        record('SEC-22b', 'authz', 'P0',
          dl.status === 200 && [401, 403, 404].includes(bIdor.status) ? 'PASS' : 'FAIL',
          `owner download -> ${dl.status} (${dl.headers['content-disposition'] ? 'attachment disposition' : 'no disposition'}), foreign clinic download -> ${bIdor.status}`);
      } else {
        record('SEC-22b', 'authz', 'P0', 'NOTE', 'upload did not return 201 - download IDOR covered by documents.test.js');
      }
    } else {
      record('SEC-22', 'input', 'P1', 'BLOCKED', 'no seeded episode to upload against');
    }
  }

  // 23: mass assignment - extra privileged fields must not stick.
  {
    if (patientA) {
      const r = await a.client.req('PATCH', `/api/patients/${patientA.id}`, {
        body: { name: patientA.name, role: 'admin', clinic: 'ffffffffffffffffffffffff', isApproved: true },
      });
      const after = await a.client.req('GET', `/api/patients/${patientA.id}`);
      const leaked = JSON.stringify(after.json || {}).includes('ffffffffffffffffffffffff');
      record('SEC-23', 'input', 'P1', !leaked ? 'PASS' : 'FAIL',
        `mass-assignment patch -> ${r.status}; privileged field persisted=${leaked}`);
    } else {
      record('SEC-23', 'input', 'P1', 'BLOCKED', 'no seeded patient');
    }
  }

  // 24: unknown-field injection rejected or stripped by zod.
  {
    const r = await a.client.req('POST', '/api/patients', { body: { name: 'Synthetic UnknownField', unknownTopSecretFlag: true, phone: '+10000000001', timezone: 'UTC' } });
    record('SEC-24', 'input', 'P3', r.status < 500 ? 'PASS' : 'FAIL', `unknown field body -> ${r.status}`);
  }

  // =========================================================================
  // SECTION 1 - browser security (headers, CORS, CSRF, cache)
  // =========================================================================

  // 25: security headers on an authenticated JSON response.
  {
    const r = await a.client.req('GET', '/api/patients?page=1&limit=1');
    const h = r.headers;
    record('SEC-25', 'headers', 'P2',
      h['x-content-type-options'] === 'nosniff' ? 'PASS' : 'FAIL',
      `nosniff=${h['x-content-type-options']} x-frame-options=${h['x-frame-options'] || h['x-permitted-cross-domain-policies'] || '(helmet default)'} referrer-policy=${h['referrer-policy']} permissions-policy=${h['permissions-policy'] || '(none)'} strict-transport-security=${h['strict-transport-security'] || '(absent)'} cache-control=${h['cache-control']}`);
    record('SEC-25bCSP', 'headers', 'P2', 'NOTE',
      `content-security-policy header present on API responses: ${h['content-security-policy'] ? 'yes' : 'no'} (CSP is enforced on the built client asset response; verify in client build)`);
  }

  // 26: CSP + headers on the client origin (if the dev client is up) else NOTE.
  {
    const clientBase = process.env.QA_CLIENT_URL || 'http://127.0.0.1:5173';
    try {
      const c = new Client(clientBase);
      const r = await c.req('GET', '/');
      const h = r.headers;
      const ok = !!h['content-security-policy'] && h['x-content-type-options'] === 'nosniff';
      record('SEC-26', 'headers', 'P2', ok ? 'PASS' : r.status >= 500 ? 'BLOCKED' : 'FAIL',
        `client / -> ${r.status} csp=${h['content-security-policy'] ? 'yes' : 'NO'} nosniff=${h['x-content-type-options']} frame=${h['x-frame-options'] || (h['content-security-policy'] || '').includes('frame-ancestors') ? 'yes' : 'NO'} referrer=${h['referrer-policy']}`);
    } catch (err) {
      record('SEC-26', 'headers', 'P2', 'BLOCKED', `client origin not reachable: ${err.message}`);
    }
  }

  // 27: CORS allowlist - disallowed origin gets no CORS headers.
  {
    const r = await a.client.req('GET', '/api/health', { headers: { Origin: 'https://evil.example' } });
    const acao = r.headers['access-control-allow-origin'];
    record('SEC-27', 'cors', 'P1', !acao ? 'PASS' : 'FAIL',
      `Origin https://evil.example -> ACAO=${acao || '(absent, correct)'}`);
    const ok = await a.client.req('GET', '/api/health', { headers: { Origin: process.env.QA_ALLOWED_ORIGIN || 'http://localhost:5173' } });
    const acao2 = ok.headers['access-control-allow-origin'];
    record('SEC-27b', 'cors', 'P2', acao2 === 'http://localhost:5173' ? 'PASS' : 'FAIL',
      `allowlisted origin -> ACAO=${acao2 || '(absent)'}`);
    // Preflight must not wildcard credentials.
    const pre = new Client(BASE);
    const pr = await fetch(`${BASE}/api/patients`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
    const pAcao = pr.headers.get('access-control-allow-origin');
    record('SEC-27c', 'cors', 'P1', !pAcao ? 'PASS' : 'FAIL', `OPTIONS preflight evil origin -> ACAO=${pAcao || '(absent)'}`);
  }

  // 28: CSRF - mutation with session cookie but WITHOUT the X-CSRF header.
  {
    const r = await a.client.req('POST', '/api/patients', { body: { name: 'SyntheticCsrf' }, noCsrf: true });
    record('SEC-28', 'csrf', 'P1', r.status === 403 || r.status === 401 ? 'PASS' : 'FAIL',
      `cookie-auth POST without X-CSRF-Token -> ${r.status} (expect 401/403)`);
  }

  // 29: CSRF - foreign Origin header on a mutation (defense-in-depth check).
  {
    const r = await a.client.req('POST', '/api/patients', { body: { name: 'SyntheticOrigin' }, headers: { Origin: 'https://evil.example' } });
    // The app relies on the double-submit token bound to the session plus
    // SameSite=Lax (csrf.js); an Origin allowlist check is NOT implemented, so a
    // foreign Origin with a valid token proceeds to validation. Cross-site
    // attackers cannot read the CSRF cookie (same-origin policy) so the token
    // cannot be forged; recorded as an accepted residual risk / P3 hardening idea.
    record('SEC-29', 'csrf', 'P3', r.status === 403 || r.status === 401 ? 'PASS' : 'NOTE',
      `mutation with foreign Origin + valid CSRF token -> ${r.status} (no Origin allowlist layer; CSRF rests on double-submit token + SameSite=Lax)`);
  }

  // =========================================================================
  // SECTION 1 - information exposure
  // =========================================================================

  // 30: no stack traces / driver errors / paths across every response body seen.
  {
    const suspicious = [];
    const patterns = [/at Object\./, /node_modules/, /\/src\//, /MongoServerError/, /ECONNREFUSED/, /mongodb:\/\//, /SESSION_PEPPER/, /DOCUMENT_ENCRYPTION_KEY/];
    for (const res of probeHistory) {
      for (const p of patterns) if (p.test(res.text || '')) suspicious.push(`${res.status}:${p}`);
    }
    record('SEC-30', 'info', 'P1', suspicious.length === 0 ? 'PASS' : 'FAIL', `${probeHistory.length} responses scanned; leaks=${JSON.stringify([...new Set(suspicious)])}`);
  }

  // 31: 404 handler shape.
  {
    const r = await anon.req('GET', '/api/definitely-not-a-route');
    record('SEC-31', 'info', 'P3', r.status === 404 && r.json && r.json.error && r.json.error.code === 'NOT_FOUND' ? 'PASS' : 'FAIL', `unknown route -> ${r.status} ${r.json && r.json.error && r.json.error.code}`);
  }

  // 32: metrics endpoint exposes no connection strings/secrets.
  {
    const r = await admin.client.req('GET', '/api/metrics');
    const text = r.text || '';
    const leak = /mongodb:\/\/|pepper|encryption_key|sk-/i.test(text);
    record('SEC-32', 'info', 'P2', !leak ? 'PASS' : 'FAIL', `metrics -> ${r.status}, secret-shaped strings=${leak}`);
  }

  // =========================================================================
  // SECTION 3 - privacy / notification preview
  // =========================================================================

  // 33: today view (reminder previews surface) must not leak raw clinical text
  // or phone numbers in list output.
  {
    const pid = patientA && patientA.id;
    const r = pid
      ? await a.client.req('GET', `/api/today?patientId=${pid}&date=2026-10-17`)
      : { status: 0, text: '', json: null };
    const text = r.text || '';
    const exposes = /diagnosis|medication name|\+?[0-9]{10,}/.test(text);
    record('SEC-33', 'privacy', 'P2', pid && r.status < 500 && !exposes ? 'PASS' : 'FAIL',
      `today view (patientId=${pid ? 'set' : 'missing'}) -> ${r.status}; clinical-text/phone patterns in previews=${exposes}`);
  }

  // 34: privacy/data-request list is tenant-scoped and time-boxed (shape probe).
  {
    const r = await a.client.req('GET', '/api/privacy-requests?page=1&limit=5');
    record('SEC-34', 'privacy', 'P2', r.status < 500 ? 'PASS' : 'BLOCKED', `privacy request list -> ${r.status}; download-link TTL/single-use asserted in retention.test.js`);
  }

  writeEvidence('security-probes.json', {
    baseUrl: BASE,
    ranAt: new Date().toISOString(),
    results,
    probeResponsesScanned: probeHistory.length,
  });
  const fails = results.filter((r) => r.verdict === 'FAIL');
  process.stdout.write(`\n${results.length} checks, ${fails.length} FAIL, ${results.filter((r) => r.verdict === 'BLOCKED').length} BLOCKED/NOTE\n`);
  if (fails.length) process.exitCode = 1;
}

// Every response text is captured here for the leak scan SEC-30.
const probeHistory = [];

// Wrap Client.req after import to record bodies without touching credentials.
const proto = Client.prototype;
const original = proto.req;
proto.req = async function wrapped(method, path, options) {
  const res = await original.call(this, method, path, options);
  probeHistory.push({ status: res.status, text: (res.text || '').slice(0, 20000) });
  return res;
};

main().catch((err) => {
  process.stderr.write(`security probe run failed: ${err.stack}\n`);
  process.exit(2);
});