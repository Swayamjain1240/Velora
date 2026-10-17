# Velora — Final Security Audit (non-functional QA pass)

**Branch:** `test/non-functional-security-qa`
**Environment:** isolated test stack — API `NODE_ENV=test` on `127.0.0.1:4101`, disposable MongoDB replica set `velora_test`, seeded synthetic identities only (`*.synthetic.invalid`), fixture tenant B created in the same disposable DB, `EXTRACTION_PROVIDER=fake`. **No probe ever left loopback.**
**Method:** defensive live HTTP probes (`node qa/security-probes.js`, 39 checks), concurrency probes (`node qa/concurrency-probes.js`), first-party source review, dependency/licence review (`node qa/dep-review.js`), Git tree/history secret scan, plus the project's own integration suite.
**Evidence:** [qa/evidence/security-probes.json](../qa/evidence/security-probes.json), [qa/evidence/concurrency.json](../qa/evidence/concurrency.json), [qa/evidence/dependency-review.json](../qa/evidence/dependency-review.json)

## 1. Result summary

| Area | Verdict |
| --- | --- |
| Authentication (hashing is Argon2id; brute force, enumeration, logout, revoke-all, MFA gate) | **PASSED** (live) |
| Authorisation / tenant isolation / IDOR (reads, lists, counts, documents, downloads) | **PASSED** (live + suite) |
| Input security (NoSQL injection, prototype pollution, XSS boundary, oversized body, duplicate keys, unknown fields, mass assignment, filename traversal) | **PASSED** after fix **NQ-1** |
| Browser security (headers, CSP, CORS, CSRF, cache) | **PASSED** after fix **NQ-2**; one accepted residual (no Origin allowlist) |
| Information exposure (stack traces, driver errors, paths, secrets, cache) | **PASSED** (76 response bodies scanned) |
| Concurrency / duplicate-state races | **PASSED** after fix **NQ-3**; one hardening gap (TOTP replay memo) |
| Supply chain (production advisories, licences, lockfile, install scripts) | **PASSED for production deps (0 advisories)**; 6 **dev-only** advisories remain — owner decision |
| Secret hygiene (ignore rules, current tree, 85-commit reachable history) | **PASSED** — no secret-shaped material found |
| Penetration testing / exploit development | **NOT RUN** — out of scope for this pass |

## 2. Live probe results (39 checks, 0 FAIL)

| ID | Check | Observed |
| --- | --- | --- |
| SEC-1 | User enumeration | unknown email and wrong password both `403 FORBIDDEN`, identical shape |
| SEC-2 | Credential stuffing / brute force | durable per-identity limiter answered `429 RATE_LIMITED` inside 12 attempts |
| SEC-3/3b/3c | Cookie flags | session `HttpOnly` + `SameSite=Lax`, path `/`; CSRF cookie JS-readable by design and `SameSite=Lax`; `Secure` absent on plain-HTTP test (expected — verify at the TLS edge) |
| SEC-4 | Logout | `/me` 200 before, 200 logout, `401` after |
| SEC-5 | Revoke all sessions | revoking session 1 invalidated session 2 **and** session 1 (both 401) |
| SEC-6/7 | MFA gate | password-only login leaves `/me` 401; wrong TOTP `403` |
| SEC-9 | Cross-clinic patient read (IDOR) | foreign clinic session → `404` (scoped, no existence leak) |
| SEC-10/11 | Cross-clinic list and dashboard | foreign list contains **0** clinic-A rows; foreign dashboard query returns no clinic-A identifiers |
| SEC-12/22b | Document list/download IDOR | foreign clinic → `404`; owner download `200` with `Content-Disposition: attachment` |
| SEC-13 | Admin vs clinical record | admin `GET /api/audit` 200; admin is refused clinical queues by design (asserted in `accessMatrix.test.js`) |
| SEC-14 | Unauthenticated access to 10 core routes (reads, writes, exports, retention, metrics) | all `401` (no unprotected route) |
| SEC-15/16 | NoSQL operator injection (body + query) | `400 BAD_REQUEST`, never 5xx, never authenticated |
| SEC-17 | Prototype-pollution payload | `400`, server healthy afterwards |
| SEC-18 | Markup/XSS string through a mutation | `400` at the validation boundary (stronger than escaping); JSON-only responses |
| SEC-19 | 2 MB JSON body | `413 PAYLOAD_TOO_LARGE` (was **500** — fixed, see NQ-1) |
| SEC-20/21/24 | Wrong content type, duplicate JSON keys, unknown fields | `400`/`403`, no 5xx |
| SEC-22 | Filename traversal on upload (`../../escape.pdf`) | `400 BAD_FILENAME`; well-formed name `201` |
| SEC-23 | Mass assignment (`role`, foreign `clinic` id) | `400`, privileged field not stored |
| SEC-25 | Response headers | `nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, `CSP frame-ancestors 'none'`, `Cache-Control: no-store, private` (was missing — fixed, NQ-2); **HSTS absent outside production by design** |
| SEC-27/27b/27c | CORS allowlist | foreign origin → no `Access-Control-Allow-Origin` (also on preflight); allowlisted origin echoed exactly; `Allow-Credentials` only with the allowlist |
| SEC-28 | CSRF | cookie-auth `POST` without `X-CSRF-Token` → `403` |
| SEC-30 | Information exposure across every probe response | 76 bodies scanned for stack frames, `node_modules`, source paths, driver errors, `mongodb://`, key names → **0 leaks** |
| SEC-31/32 | Error and metrics shape | unknown route `404 NOT_FOUND` envelope; `/api/metrics` exposes no connection strings or secret-shaped strings |
| SEC-33/34 | Privacy surfaces | today view 200 with no clinical-text/phone patterns in previews; privacy-request list 200 (artifact TTL/single-use asserted in `retention.test.js`) |

### Concurrency probes (6 checks)

| ID | Result |
| --- | --- |
| CON-1 | 8 parallel invitations for one email → **1×201 + 7×409**, exactly one active token (was 8 — fixed, NQ-3) |
| CON-2 | 20 parallel patient-list reads → all 200, identical totals (no torn read) |
| CON-3 | 6 in-flight reads racing logout → no 5xx |
| CON-4 | TOTP code accepted twice in the same 30 s window across two sessions → **NOTE / P3** (RFC 6238 window token; NIST 800-63B prefers single use; no replay memo in `mfaService.verifyTotp`) |
| CON-5 | 6 parallel patient creates → all 201, no 5xx |
| CON-6 | Workflow races (invitation accept, activation, caregiver revoke, correction revision, approve-vs-edit, reminder dedup, closure, export, retention) → asserted by the integration suite inside MongoDB transactions |

## 3. The 25-control contract

| # | Control | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Hide and rotate keys/secrets | **PASSED** | no secret in tree or 85-commit history; `qa/.sessions/` ignored; reports redacted (cookie values `[redacted]`) |
| 2 | Validate env, fail closed | **PASSED** | `env.js` zod validation; probe `loadEnv` refused a config missing `PORT` |
| 3 | Protect every route/file/job | **PASSED** | SEC-14 (10 routes) + per-router `requireAuth`/`loadClinicContext` mount audit |
| 4 | Argon2id, MFA, sessions, recovery, CSRF | **PASSED** | SEC-3..7, SEC-28; recovery codes are HMAC-hashed and consumed atomically |
| 5 | Server-side access on reads/writes/lists/counts/downloads/exports/jobs | **PASSED** | SEC-9..12, SEC-22b; clinic scope derives from membership only (`loadClinicContext`), never a client id |
| 6 | Validate every input, prevent NoSQL injection | **PASSED** | SEC-15..24; zod `.strict()` schemas |
| 7 | Prevent XSS and unsafe rendering | **PASSED** | SEC-18 (validation rejects markup); JSON-only responses; React text rendering |
| 8 | Atomic/distributed rate and resource limits | **PASSED** | SEC-2 + limiter-under-pressure phase (119×200 / 31×429, health stayed 200); hard byte cap in `boundedBody` |
| 9 | Safe errors, redacted logs | **PASSED** | SEC-30 (0 leaks), structured logger with request id; 5xx message generic in production |
| 10 | Exact CORS allowlist | **PASSED** | SEC-27/27b/27c |
| 11 | Helmet, CSP, HSTS, file headers | **PASSED (API) / PARTIAL (client shell)** | SEC-25; HSTS production-only by design; API serves CSP + `nosniff`; the Vite/static client shell has no CSP header or meta — see R-4 |
| 12 | Production debug off | **PASSED** | verbose 5xx message only outside production |
| 13 | Review advisories before upgrades | **PASSED** | `npm audit` reviewed; dev-toolchain fixes need semver-major upgrades → deliberately not forced (D-5) |
| 14 | Remove unused packages | **PASSED (no action)** | 25 direct deps, all tooling or runtime in use; flagged "not imported" entries are CLI/config-driven (`vite`, `eslint*`, `jsdom`, `supertest`) |
| 15 | Find exposed env files/keys/uploads/exports/backups/source maps | **PASSED** | `.env`, `.env.*`, `server/.env`, `node_modules` ignored; uploads/exports live outside the repo (`DOCUMENT_STORAGE_ROOT` is validated to be outside); build emits no source maps by default (checked `client/vite.config.js`) |
| 16 | MongoDB credentials, TLS, network boundaries | **PARTIAL (deployment)** | test URI is loopback with no credentials; production TLS/credentials/network boundary are deployment decisions — **owner sign-off required** |
| 17 | Argon2id/bcrypt, no plaintext passwords | **PASSED** | `@node-rs/argon2`; `passwordHash` `select:false`; no plaintext in probes or logs |
| 18 | Scan reachable Git history and current tree | **PASSED** | current tree: only `.env.example` placeholders; 85 reachable commits: 0 secret-shaped hits |
| 19 | Final security audit / threat model | **PASSED** | this document + [FINAL_THREAT_MODEL.md](FINAL_THREAT_MODEL.md) |
| 20 | Test → inspect diff → meaningful commit → push | **PASSED** | three focused fix commits + docs; no history rewrite |
| 21 | Treat security as continuous | **PASSED** | CI runs server tests, audits, secret scan; residual risks recorded with owners |
| 22 | Disclose external providers before integration | **PASSED** | `EXTRACTION_PROVIDER=none` by default; the fake provider is local; a real AI/mail provider remains an owner decision |
| 23 | Test every feature and recovery path | **PASSED (with limits)** | server suite **420/420**, client **61/61** + lint + build, browser journeys **37/37** (a11y + one-viewport), restore drill **PASSED**, reconciliation repair exercised with operator attribution; penetration testing NOT RUN |
| 24 | Synchronise documentation and evidence | **PASSED** | Duck Log + README updated with the three fixes and this pass |
| 25 | Every authenticated screen fits one viewport without clipping | **PASSED (browser journeys)** | see [FINAL_ACCESSIBILITY_REPORT.md](FINAL_ACCESSIBILITY_REPORT.md) |

## 4. Dependency and supply-chain findings

- **Production dependencies:** `npm audit --omit=dev` → **0 vulnerabilities** (CI gate).
- **Development toolchain:** 6 advisories — 2 critical (`tinypool`, `vitest`), 1 high (`vite`), 3 moderate (`esbuild`, `vite-node`, `@vitest/mocker`). All fixes require **semver-major** upgrades (`vite@8`, `vitest@5`), so they were reviewed and **not forced** in this pass (D-5). Practical exposure is limited to developer machines running the dev server or Vitest; no such component ships to production.
- **Licences:** MIT, Apache-2.0, BSD-2-Clause only — **no copyleft/restrictive** licence in the direct set.
- **Install scripts:** direct dependencies declare `prepare`/`prepack` only (publisher-side); **no `preinstall`/`install`/`postinstall` hook** runs in this tree.
- **Lockfile:** `package-lock.json` committed (lockfileVersion 3).
- **CI actions:** `actions/checkout@v4`, `actions/setup-node@v4`, `gitleaks/gitleaks-action@v2` — major-version tags, not SHA-pinned (R-5).

## 5. Fixed in this pass (details in [FINAL_DEFECT_LOG.md](FINAL_DEFECT_LOG.md))

| ID | Defect | Fix | Retest |
| --- | --- | --- | --- |
| NQ-1 | Oversized/malformed JSON body returned **500** | `errorHandler` maps body-parser failures to 413/400/415 with fixed messages | live `413`, new integration tests (5/5) |
| NQ-2 | Authenticated JSON responses could be cached (no default `Cache-Control`) | `securityHeaders` sets `no-store, private` unless a controller set its own | live `no-store, private`, new integration tests |
| NQ-3 | 8 parallel invitations for one email created 8 live tokens | service pre-check + partial unique index on live `(clinic,email)`; `dedupe-invitations.js` for pre-existing duplicates | live 1×201 + 7×409, new integration tests (3/3) |

## 6. Residual risk and decisions still required

| Ref | Risk | Severity | Owner decision |
| --- | --- | --- | --- |
| R-1 | TOTP code reusable inside its 30 s window (CON-4) | P3 | Implement a single-use step memo, or accept the RFC 6238 window semantics. |
| R-2 | No Origin/Referer allowlist layer on mutations (SEC-29) | P3 | CSRF currently rests on the double-submit token bound to the session plus `SameSite=Lax`; adding an Origin check is defence-in-depth but must be threaded through the test suites. |
| R-3 | `Secure` cookie flag and HSTS are production-only | P2 (deployment) | Verify at the real TLS edge; a misconfigured proxy would drop both protections. |
| R-4 | The client shell (Vite/static host) serves no CSP header or `<meta>` CSP | P2 (deployment) | Set a CSP at the hosting layer; recommended directives: `default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`. |
| R-5 | CI actions pinned to major tags | P3 | Pin to commit SHAs once the workflow is stable. |
| R-6 | 6 dev-toolchain advisories | P2 (dev) | Schedule the `vite@8`/`vitest@5` upgrade with a full re-run of suites and journeys. |
| R-7 | MongoDB credentials/TLS/network boundary not exercised | P1 (deployment) | Production DB must require auth + TLS and live on a private network; unverified here because only a local disposable replica set was available. |
| R-8 | No penetration test, no fuzzing, no external scanner | — | Out of scope; CI already runs `gitleaks` (tree) and `npm audit`. |
| R-9 | One test (`plans.test.js:798`, parallel approval) is stricter than the design: under heavy CPU contention it failed because the second parallel approval was answered as an idempotent retry (`200` + `idempotent:true`) instead of `409` | P3 (test stability) | Re-run alone 24/24 and the full quiet suite 420/420; either relax the assertion to accept the idempotent-retry outcome or make the test drive the two approvals with a barrier so they are genuinely concurrent. |
