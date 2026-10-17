# Velora — Final Threat Model (non-functional QA pass)

Companion to [VELORA_THREAT_MODEL.md](VELORA_THREAT_MODEL.md) (the product threat model written with Part 2). This document records **what this pass re-examined, what changed, and what remains open**. It is a software-security threat model, not a clinical or regulatory risk assessment.

**Branch:** `test/non-functional-security-qa` · **Environment:** isolated test stack (loopback only, synthetic data)

## 1. Assets

| Asset | Where it lives | Protection observed |
| --- | --- | --- |
| Clinical documents (discharge notes) | encrypted objects under `DOCUMENT_STORAGE_ROOT` (outside the repo) + metadata in Mongo | AES-256-GCM per object, key from env, checksum recorded, download re-authorized per request |
| Care plans / versions / approvals | MongoDB (`velora_test` here) | one current approved version per episode; transactions on approval; audit events |
| Patient identity + contact data | MongoDB | tenant- and assignment-scoped reads; no clinic id ever accepted from the client |
| Sessions / MFA secrets / recovery codes | MongoDB | opaque token hashed with a pepper; TOTP secret sealed per user; recovery codes HMAC-hashed and consumed atomically |
| Privacy exports | encrypted artifacts + short-lived single-use download grants | TTL + single use asserted by `retention.test.js` |
| Audit trail | append-only collection | scoped, paginated, actor-attributed; admin reads it, coordinators do not |
| Secrets (pepper, keys) | environment only | never in the repo, the client bundle or a log line (verified) |

## 2. Actors and trust boundaries

- **Anonymous internet caller** → CORS allowlist, helmet headers, rate limits, `401` on every protected route (verified live).
- **Authenticated staff member (any clinic)** → server-derived clinic scope and permission set; cross-tenant reads answered `404` (verified live).
- **Authenticated patient / caregiver** → scoped to their own linked profile or explicit grant.
- **Clinic administrator** → holds **no** clinical permission by design; `403` on patient lists (verified live).
- **Clinic-verified clinical reviewer** → the only actor who can approve a care plan.
- **Operator / deployment** → holds env secrets, backup material and the DB; out of scope for application testing but explicitly listed as an owner decision in the security audit (R-7).
- **Third-party providers** → `EXTRACTION_PROVIDER=none` by default; the QA stack used the **local fake provider only**. No real AI, mail, or SMS provider was contacted.

## 3. Threats reviewed in this pass

| Threat | STRIDE | Review result |
| --- | --- | --- |
| Credential stuffing / brute force on login and MFA | Spoofing | MSS: durable per-identity limiter refused after 10 attempts (SEC-2); MFA gate holds without a TOTP (SEC-6/7) |
| User enumeration through login responses | Information disclosure | Identical `403 FORBIDDEN` for unknown email and wrong password (SEC-1) |
| Session fixation, logout bypass, session hoarding | Spoofing | session cookie rotates at promotion; logout and revoke-all invalidate immediately (SEC-4/5) |
| Cross-tenant read/write (`IDOR`) | Elevation / disclosure | `404` for foreign patient, list, dashboard, document list and document download (SEC-9..12, SEC-22b) |
| Count/total leakage across tenants | Information disclosure | foreign list totals 0; dashboard returns no foreign identifiers (SEC-10/11) |
| CSRF on cookie-authenticated mutations | Tampering | missing/incorrect `X-CSRF-Token` → `403` (SEC-28); `SameSite=Lax` |
| NoSQL operator injection / prototype pollution | Tampering | `400` with no 5xx and no authentication (SEC-15..17) |
| Stored/reflected XSS through clinical text | Tampering | markup rejected at the validation boundary; JSON-only responses (SEC-18) |
| Path traversal through a document filename | Tampering | `400 BAD_FILENAME` for `../../escape.pdf`; filenames never appear in URLs (SEC-22) |
| Mass assignment of role/clinic fields | Elevation | `400`, field not persisted (SEC-23) |
| Memory exhaustion through a huge body | DoS | 2 MB JSON → `413` (was `500`, fixed NQ-1); documents stream under a hard byte cap |
| Cached clinical data in a browser/shared cache | Information disclosure | `Cache-Control: no-store, private` on every API response (was inconsistent, fixed NQ-2) |
| Duplicate live invitations for one address | Spoofing (extra valid tokens) | service pre-check + partial unique index; 8 parallel posts → 1×201 + 7×409 (fixed NQ-3) |
| Error/stack/path leakage | Information disclosure | 84 response bodies scanned, 0 leaks; unknown route returns a safe envelope (SEC-30) |
| Dependency compromise | Supply chain | production audit clean; dev-toolchain advisories recorded and not force-upgraded; no install-time hooks in direct deps |
| Secret leakage via Git | Information disclosure | current tree + 85-commit history scanned, no secret-shaped material |

## 4. Threats NOT tested in this pass

- **Exploit development / penetration testing**, memory-safety fuzzing, or bypassing the CSRF token with a valid session — out of scope by the task's rules.
- **Real provider integration** (AI extraction vendor, mail/SMS) — no provider is authorized yet; the fake provider was used.
- **Infrastructure attacks**: TLS downgrade, proxy header spoofing in a real deployment, MongoDB network exposure, backup-at-rest theft, insider access to the host. These are deployment decisions and are listed as owner items (R-3, R-7).
- **Multi-tenant abuse at scale** (e.g. thousands of clinics, index collisions) — only two tenants exist in the test fixture.
- **Clinical safety** of any AI suggestion or translated rendering — explicitly out of scope; software QA does not validate clinical accuracy.

## 5. Residual-risk statement

The three fixed defects (NQ-1..NQ-3) were confirmed by live re-probe and by new integration tests. The remaining items are recorded with severity and an owner decision in [FINAL_SECURITY_AUDIT.md](FINAL_SECURITY_AUDIT.md) §6 and [FINAL_DEFECT_LOG.md](FINAL_DEFECT_LOG.md). No claim of zero vulnerabilities or of regulatory compliance is made: this pass covered application behaviour on an isolated stack with synthetic data only.
