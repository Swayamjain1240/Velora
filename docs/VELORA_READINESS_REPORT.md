# Velora MERN - Part 10 Readiness Report

Final review of the ten-part build: what is **PASSED**, what is **FAILED**, what is **BLOCKED** and
what is **NOT APPLICABLE**, with the evidence behind each verdict. Evidence classes stay the Duck
set: `VERIFIED`, `IMPLEMENTED / UNVERIFIED`, `PARTIAL`, `PLANNED`, `DRIFT`, `BLOCKED`, `NOT
APPLICABLE`.

> This report does **not** claim zero bugs, regulatory compliance, clinical validation or
> real-patient readiness. No deployment happened, no external provider is connected, no real patient
> data ever entered the system, and no destructive deletion or real restore has been performed. The
> exact owner decisions still required are listed in §7.

Date: 16 October 2026 · Branch: `main` · Repository: `Velora`

---

## 1. Gate evidence (local, synthetic data only)

| Check | Command | Result |
|---|---|---|
| Server unit + integration + concurrency | `npm test -w server` (replica-set MongoDB) | **388 passed / 0 failed**, exit 0 |
| Client unit tests | `npm test -w client` | **61 passed / 0 failed** (11 files), exit 0 |
| Client lint | `npm run lint -w client` | clean, exit 0 |
| Client production build | `npm run build -w client` | built in ~1.5 s: `index.js` 368.38 kB (101.34 kB gzip), `index.css` 13.47 kB (3.02 kB gzip) |
| Browser journeys (Chromium, six viewport sizes) | `EXTRACTION_PROVIDER=fake npx playwright test` against `EXTRACTION_PROVIDER=fake NODE_ENV=test` API | **64 passed / 0 failed / 2 skipped** of 66, exit 0 |
| Provider fails closed with no provider | restart API with `EXTRACTION_PROVIDER=none`, `npx playwright test e2e/extractions.spec.js -g "no provider enabled"` | **1 passed**, exit 0 |
| Restore drill | `npm run restore:drill -w server` | **PASSED** - 48 collections, 4176 rows, 162 encrypted objects (6 054 128 bytes), 25/25 stored documents decrypted from the restored copy with matching hashes, source unchanged, drill database dropped |
| Document reconciliation | `node server/scripts/reconcile-documents.js` | 174 metadata rows / 174 stored objects, **0** missing, unreadable, mismatched or orphan; dry run changed nothing |
| Production dependency audit | `npm audit --omit=dev` | **0 vulnerabilities** |
| Full dependency audit (incl. dev tooling) | `npm audit` | 6 advisories (3 moderate, 1 high, 2 critical) — **dev/test toolchain only** (vitest → vite → esbuild chain); not shipped, tracked in §7 |
| Secret scan (tree) | pattern scan for provider keys, private keys and credentialed URIs | clean |
| Secret scan (reachable history, all commits) | `git grep` over `git rev-list --all` | clean |

Two skipped journeys are deliberate: the opt-in live quarantine journey (`E2E_QUARANTINE=1`) and the
provider-disabled journey when the provider IS enabled (it runs in its own step, above).

The gate was re-run on the frozen final tree after every repair; earlier passing runs are not used as
evidence for later changes.

---

## 2. Part 10 work items

| # | Item | Verdict | Evidence / note |
|---:|---|---|---|
| 1 | Production configuration schema | **PASSED** | `NODE_ENV=production` now refuses: non-HTTPS or non-bare `CLIENT_ORIGIN`, `LOG_LEVEL=debug`, a pepper under 32 chars, any reused encryption key, a non-TLS `MONGODB_URI`, and an impossible pool bound. Body, request, pool and shutdown budgets are all configurable and bounded. 15 unit cases in `tests/unit/env.test.js` |
| 2 | Provider-neutral production decisions | **PASSED (register written, nothing selected)** | [VELORA_PROVIDER_DECISIONS.md](VELORA_PROVIDER_DECISIONS.md): seven capabilities with candidates evaluated from the Gravity Index catalogue, the control-#22 disclosure template, and what each selection blocks. Every row is `NOT SELECTED` |
| 3 | Health/readiness, graceful shutdown, pool, request ids, redacted logs | **PASSED** | `/api/health` (liveness, dependency-free) and `/api/ready` (real DB `ping` + storage writability, 503 with a named failing side, `draining` before the listener closes); bounded pool/timeouts; `X-Request-Id` on every response; structured JSON logger with deep redaction and production stack suppression; one-per-state-change alert events. 5 unit + 5 integration cases |
| 4 | Session/cookie/proxy/CSRF/CORS/CSP/HSTS hardening and rotation strategy | **PARTIAL** | Proxy trust is now an explicit operator decision (a hardcoded hop was a real drift); HSTS is production-only and explicit; cookie/token handling re-verified (host-only, httpOnly, sameSite, secure in production, peppered hashes, revocable, MFA). **Key rotation for MFA secrets and stored documents has no re-seal script** — documented as NOT IMPLEMENTED with the required procedure |
| 5 | Backup/restore runbooks + isolated synthetic restore test | **PARTIAL** | Runbook written with the four-asset backup set, the ordered restore procedure, observed drill timings and the honest RPO/RTO boundary. The drill runs and passes. **A provider backup schedule/cadence does not exist**, so RPO is not bounded and no provider-level or point-in-time restore was exercised |
| 6 | Storage integrity, retention dry run, queue/version reconciliation, disaster behaviour | **PASSED (local)** | Reconciliation reports 0 drift on the seeded set; reconciliation repairs require an operator attribution; retention dry run verified repeatable; plan-version reconciliation supersedes future occurrences while leaving history untouched; per-dependency failure behaviour documented (Mongo down, storage unusable, provider disabled, tampered object, slow client, forced shutdown) |
| 7 | Threat model | **PASSED** | [VELORA_THREAT_MODEL.md](VELORA_THREAT_MODEL.md): eleven scenarios (tenant escape, BOLA, credential stuffing, session theft, stored XSS, NoSQL injection, malicious uploads, prompt injection/data leakage, supply chain, insider/admin misuse, availability) each with the implemented mitigation, the residual risk, and the deployment-dependent gaps marked BLOCKED |
| 8 | CI protections | **PASSED** | Lockfile + `npm ci`, production dependency audit, gitleaks tree/history scan, server/client/browser gates, and **newly added**: the restore drill and the read-only reconciliation report run on every push against the seeded database. Branch-protection recommendations recorded; no gate was weakened |
| 9 | Accessibility, keyboard, responsive, empty/error/loading states | **PARTIAL** | Six-size one-viewport assertions cover every authenticated screen; a new keyboard journey proves shell traversability, a visible focus indicator (2px+ outline) and keyboard activation of a navigation control; journeys address controls by role/name, which requires accessible names. **BLOCKED**: no screen-reader run, no automated contrast/axe audit, no Safari/Firefox run (Chromium project only), no physical device, no extreme-zoom test |
| 10 | Readiness report with explicit gates | **PASSED** | This document |

---

## 3. Security-25 control matrix (final)

| # | Control | Verdict | Evidence |
|---:|---|---|---|
| 1 | Secrets hidden; keys rotated | **PARTIAL** | No secret in the client bundle, logs, responses, fixtures or Git; three separate 32-byte keys + pepper, reuse refused in production; **rotation implemented only for the session pepper** (MFA/document re-seal scripts missing) |
| 2 | Required env validated, fail closed | **PASSED** | Startup refuses a bad configuration (field names only); production-only rules; provider gate fails closed; new runtime budgets validated |
| 3 | Protect every private route/file/job | **PASSED** | Every `/api` surface requires authentication + scope except the two probes (which disclose nothing) and the public invitation/landing routes; documents are never served from a public path |
| 4 | Argon2id, mandatory staff MFA, revocable sessions, recovery, CSRF | **PASSED** | Verified unchanged in Part 10; MFA enrollment is a compare-and-set and cannot be replaced during a password-only session; step-up for sensitive actions |
| 5 | Server-side clinic/role/assignment/ownership/grant/state on reads, writes, lists, counts, exports, jobs | **PASSED** | Re-derived per request; cross-clinic/unauthorized cases asserted per surface; admin holds no clinical read |
| 6 | Validate/sanitize input; prevent NoSQL injection | **PASSED** | Strict zod schemas per route, ObjectId validation, primitive-only queries, generic 400s |
| 7 | Prevent XSS / unsafe rendering | **PASSED (API) / BLOCKED (client host)** | JSON-only API with `default-src 'none'` CSP; no `dangerouslySetInnerHTML` in the client; documents are never rendered inline. The client host's own headers/TLS are a deployment task |
| 8 | Distributed/atomic rate and resource limits | **PASSED** | Durable Mongo-backed limiter, bounded bodies/timeouts/pool/export/retention/audit ranges, per-IP coarse limiter (measured: request 301 in a window → 429) with its NAT caveat documented |
| 9 | Consistent safe errors, redacted logs | **PASSED** | One error envelope; production 5xx messages generic; new structured logger redacts sensitive keys at depth, suppresses production stacks, and never logs clinical text; audit-write failure is an alert event |
| 10 | Exact CORS allowlist | **PASSED** | Single exact origin, credentialed, no wildcard, no ACAO for a foreign origin; `CLIENT_ORIGIN` must now be a bare origin |
| 11 | CSP/Helmet/HSTS and attachment headers | **PARTIAL** | Helmet CSP/`nosniff`/frame/referrer policies on the API; HSTS now explicit and production-only; downloads are attachment-typed behind authorization. Client-origin headers remain a deployment responsibility |
| 12 | Production debug off | **PASSED** | Non-production stack/diagnostic messages; `LOG_LEVEL=debug` refused in production; x-powered-by disabled; trust proxy is explicit rather than defaulted |
| 13 | Dependency advisories checked before upgrades | **PASSED with a documented finding** | `npm audit --omit=dev` = 0; 6 dev-only advisories remain (test toolchain) and are reported as a limitation rather than hidden |
| 14 | Remove unused packages | **PASSED** | No unused dependency in `server`/`client`; Part 10 added **no** dependency (logger and readiness are hand-written over the standard library) |
| 15 | Find exposed keys/uploads/exports/backups/source maps | **PASSED (local)** | Tree and full-history scans clean; `.env` never committed; exports/backups/keys ignored; drills and reconciliation operate on synthetic data |
| 16 | Secure Mongo credentials/TLS/network boundaries | **PARTIAL** | TLS mandatory in production, credentials server-only, pool bounded, private access rules. Region/network boundary and provider DB audit logs are **BLOCKED** on the database selection |
| 17 | Argon2id/bcrypt only, no plaintext | **PASSED** | Argon2id via `@node-rs/argon2`; no plaintext or reversible password storage anywhere |
| 18 | Scan reachable history and tree for secrets | **PASSED** | Pattern scans over the tree and every reachable commit are clean (a synthetic credentialed-URI fixture found during Part 10 was removed from the tree **and** from history by rewriting the unmerged commit before it could reach CI) |
| 19 | Final security audit / threat model | **PASSED** | Threat model + this matrix; every UNVERIFIED/PARTIAL/BLOCKED item is named rather than implied |
| 20 | Coherent fix → test → diff → meaningful commit; 50+ real commits | **PASSED** | Five Part 10 commits, each coherent and independently verified (runtime hardening, restore drill, accessibility journey, CI drill step, Part 10 records); 79 commits total, no padding |
| 21 | Security continuously maintained | **PASSED** | CI gate on push/PR; new runtime log/readiness surfaces include their own tests; no gate disabled |
| 22 | Disclose every external provider before integration | **PASSED** | No provider connected; the register carries the required disclosure fields, and the extraction and reminder registries still fail closed on any undisclosed name |
| 23 | Test every feature and failure/recovery path | **PASSED (local)** | Failure paths exercised: bad configuration, disabled provider, unusable storage, readiness states, reconciliation drift report, restore verification, cross-clinic denials, concurrency collisions |
| 24 | Synchronize README, docs, runbooks and evidence | **PASSED** | README, structure, architecture, system design and the session log updated with this part; new runbook/register/threat-model/report added |
| 25 | Every authenticated screen fits one viewport; six sizes | **PASSED** | 64 browser journeys including six-size measurement of every authenticated screen across five role sessions (session-sharing interaction found and fixed while adding the keyboard journey) |

---

## 4. Requirement traceability (VEL-001 .. VEL-021)

| ID | Requirement | Verdict | Part 10 addition |
|---:|---|---|---|
| VEL-001 | Account and invitation security | VERIFIED (local scope) | Readiness/shutdown changes do not alter auth; session cookie/proxy assumptions re-verified |
| VEL-002 | Clinic and record isolation | VERIFIED (local scope) | Tenant scoping unchanged; probes deliberately disclose no tenant data |
| VEL-003 | Recovery episodes and assigned team | VERIFIED (local scope) | Failure behaviour documented |
| VEL-004 | Private validated document intake | VERIFIED (local scope) | Storage readiness probe added; reconciliation re-run with 0 drift; no antivirus provider (unchanged) |
| VEL-005 | Manual draft and source review | VERIFIED (local scope) | Unaffected; still the shipped default with AI off |
| VEL-006 | Clinical approval gate | VERIFIED (local scope) | Approval transaction unchanged |
| VEL-007 | Patient current-approved plan view | VERIFIED (local scope) | Unaffected |
| VEL-008 | AI extraction with source evidence | VERIFIED (local scope) | Provider gate re-verified fail-closed on the final tree; provider selection still an owner decision |
| VEL-009 | Reviewed Hindi/English presentation | VERIFIED (local scope) | Unaffected |
| VEL-010 | Immutable care-plan versioning | VERIFIED (local scope) | Reconciliation rule documented: superseded versions keep history |
| VEL-011 | Granular caregiver sharing | VERIFIED (local scope) | Grant immutability/partial-unique index surfaced by the restore drill (index fidelity) |
| VEL-012 | Medication schedules and actor logs | VERIFIED (local scope) | Reconciliation behaviour documented |
| VEL-013 | Daily recovery tasks | VERIFIED (local scope) | Unaffected |
| VEL-014 | Notifications and delivery records | VERIFIED (local scope) | Delivery failure → operator visibility documented; no provider selected |
| VEL-015 | Clinic-defined recovery check-ins | VERIFIED (local scope) | Unaffected |
| VEL-016 | Clarification queue and history | VERIFIED (local scope) | Unaffected |
| VEL-017 | Assigned team dashboard | VERIFIED (local scope) | Six-size measurement re-run |
| VEL-018 | Basic prescribed follow-up | VERIFIED (local scope) | Unaffected |
| VEL-019 | Operational closure and history | VERIFIED (local scope) | Unaffected |
| VEL-020 | Privacy, audit, export/deletion and retention | VERIFIED (local scope) | Destructive deletion still not implemented by policy; retention operator gate unchanged |
| VEL-021 | Workflow metrics without clinical inference | VERIFIED (local scope) | Metric definitions unchanged; metrics screens re-measured at six sizes |

---

## 5. Readiness by area

| Area | Verdict | Why |
|---|---|---|
| Software correctness (local, synthetic) | **PASSED** | 388 server + 61 client tests, 64 browser journeys, lint and build all green on the frozen tree |
| Security controls (design + local verification) | **PASSED with named gaps** | No open unresolved finding in code; key rotation, provider-side controls and client-host headers remain |
| Data durability | **PARTIAL** | A restore is proven possible and verifiable; no backup schedule exists, so RPO is unbounded and no off-host/point-in-time restore was exercised |
| Operations | **PARTIAL** | Probes, shutdown, logging, failure behaviour and runbooks exist; on-call routing, alerting and monitoring provider are not selected |
| Clinical readiness | **BLOCKED** | Clinical workflow review, procedure selection, authorized datasets and a labelled clinical evaluation have not happened |
| Privacy/legal readiness | **BLOCKED** | DPIA-equivalent assessment, lawful basis, notification obligations, retention windows and data-subject process are owner/DPO decisions |
| Regulatory compliance | **NOT APPLICABLE / NOT CLAIMED** | No certification, HIPAA/GDPR equivalence or clinical validation is claimed |
| Deployment | **BLOCKED** | No provider selected, no environment provisioned, no penetration test, no load test |

---

## 6. Defects found and fixed during Part 10

1. **Production could start with an unusable security posture.** Debug logging, one key reused across
   the MFA, document and export stores, a development-strength pepper, an unencrypted database
   connection and an impossible pool bound were all accepted. They are now refusals with tests.
2. **`TRUST_PROXY` was validated but never used, and `trust proxy` was hardcoded to 1.** A deployment
   that explicitly said "no proxy" still trusted a forwarding header, so a caller could rewrite the
   address that rate limits and the audit trail record. Proxy trust is now the operator's explicit
   decision, and a startup warning names the misconfiguration.
3. **`npm run seed` failed on a host that exports `PORT=0`.** Diagnosed as an environment artefact of
   the developer shell (the value is exported by the host process), not a code defect; the documented
   procedure (explicit `PORT`) works and the validator still rejects a literal `0` by design.
4. **The restore drill rejected its own restore.** A *partial* unique index (at most one ACTIVE
   caregiver grant) was rebuilt as a *full* unique index, so legitimately repeated rows from revoked
   grants were refused. Index options are now recreated and compared; the failure is reported as a
   finding. This is the kind of defect only a restore test can find.
5. **A synthetic credentialed-URI fixture could have tripped the CI secret scan.** Removed from the
   tree and rewritten out of the unmerged commit's history.
6. **The new keyboard journey signed out a shared session**, failing seven later journeys that reuse
   it. The journey now proves activation on a navigation link and makes no state change. Found only
   because the whole browser suite was re-run after adding the spec.

---

## 7. Owner / clinical / privacy decisions still required

1. **Provider selection** for hosting, managed MongoDB, private object storage, notification delivery,
   scheduling/jobs, AI/OCR and monitoring — each with its control-#22 disclosure
   ([register](VELORA_PROVIDER_DECISIONS.md)).
2. **Backup cadence, location, encryption, retention, access audit**, and therefore the real RPO/RTO
   commitments the runbook must state.
3. **Key re-seal scripts** for `MFA_ENCRYPTION_KEY` and `DOCUMENT_ENCRYPTION_KEY` rotation.
4. **Retention windows and scheduling** per clinic, and the legal basis for each clinical category.
5. **Clinical governance**: which procedure(s) are in scope, who reviews the clinical workflow, which
   authorized datasets may be used, and what the clinical acceptance criteria are.
6. **Privacy/legal**: DPIA-equivalent, lawful basis, data-subject process, incident/notification
   obligations and timelines.
7. **Incident ownership and response hours**, on-call escalation, and a break-glass policy for
   infrastructure access.
8. **Partner clinic and pilot cohort**, plus an explicit authorisation before any real patient data is
   introduced.
9. **Accessibility acceptance**: screen-reader, contrast and cross-browser testing, and the target
   conformance level.
10. **Dev-toolchain advisories**: decide whether to take the vitest/vite major upgrade that clears the
    6 dev-only advisories.

## 8. Claims that must not be made

- "Production ready", "deployed", "monitored" or "backed up on a schedule".
- "Restore tested end to end" beyond the logical, same-host, synthetic drill described above.
- "Clinically validated", "diagnosis", "recovery certified", "adherence measured" or "readmission
  reduced" — the metrics and AI surfaces exist precisely to prevent that inference.
- "Compliant" with HIPAA, GDPR, DPDP or any certification.
- "Zero known bugs" — this report enumerates what is verified, what is partial and what is blocked.
